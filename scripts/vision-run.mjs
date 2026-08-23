#!/usr/bin/env node
// scripts/vision-run.mjs — прогон зрения по карточкам кластерами, с выгрузкой
// модели между кластерами и возобновлением с места обрыва.
//
// Зачем кластеры: 12B-модель занимает ~9 ГБ из 16, и после долгого прогона
// Mac Mini уходит в своп — страдают соседние службы. Поэтому после каждых N
// карточек модель выгружается из памяти, скрипт ждёт, пока своп опустится,
// и только потом берёт следующий кластер. Это же даёт контрольные точки:
// прогон на десять часов можно прервать и продолжить.
//
// Запуск:
//   node scripts/vision-run.mjs --stage gate  --top 500
//   node scripts/vision-run.mjs --stage attrs --ids ids.txt --cluster 25
//   node scripts/vision-run.mjs --stage gate  --top 500 --resume
//
// Результат дописывается в JSONL: out/vision-<stage>.jsonl (одна карточка —
// одна строка). Повторный запуск с --resume пропускает уже сделанное.

import fs from 'fs';
import path from 'path';
import { fetchCard, photoUrls, hardRejectByOptions, mapLimit } from '../lib/wbCard.js';
import { ask, unload, memory, waitForMemory, loaded, sleep } from '../lib/ollamaClient.js';

// ── Аргументы ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const STAGE = arg('stage', 'gate');
const MODEL = arg('model', 'gemma3:12b');
const CLUSTER = Number(arg('cluster', 25));
const TOP = Number(arg('top', 0));
const IDS_FILE = arg('ids');
const SIZE = arg('size', STAGE === 'gate' ? 'c246x328' : 'c516x688');
const OUT_DIR = arg('out', path.resolve(process.cwd(), 'out'));
const COOL_MS = Number(arg('cool', 5000));
const MIN_FREE_GB = Number(arg('min-free', 3));
const MAX_SWAP_MB = Number(arg('max-swap', 3072));

if (!['gate', 'attrs'].includes(STAGE)) {
  console.error('--stage должен быть gate или attrs');
  process.exit(1);
}

// ── Промпты и схемы: те же, что в бенчмарке ─────────────────────────────────
const GATE = {
  photos: 1,
  numPredict: 60,
  prompt: `Classify the garment in this product photo.
Ignore the model, background, text overlays and styling — judge the garment only.
"shirt" means classic shirt construction: a turn-down collar AND a full
centre-front button placket. A top lacking either is "blouse_non_shirt".`,
  schema: {
    type: 'object',
    properties: {
      garment_type: {
        type: 'string',
        enum: ['shirt', 'blouse_non_shirt', 'dress', 'jacket', 'tshirt',
               'knitwear', 'suit', 'other'],
      },
      photo_usable: { type: 'boolean' },
    },
    required: ['garment_type', 'photo_usable'],
  },
};

// Только признаки, которых нет в характеристиках карточки и которые модель
// берёт уверенно. Каждое лишнее поле в схеме стоит точности на остальных:
// добавление body_length и shoulder обрушило манжету с 6/6 до 1/6.
const ATTRS = {
  photos: 2,
  numPredict: 200,
  prompt: `Catalogue this garment from the photos.
Ignore colour, the model, background, text overlays and styling — judge construction only.
Combine evidence from all photos: a feature hidden on one may be visible on another.
If a feature is hidden by pose, tucking or cropping in every photo, answer "unknown".`,
  schema: {
    type: 'object',
    properties: {
      collar: {
        type: 'string',
        enum: ['classic_turn_down', 'stand', 'mandarin', 'polo', 'round_neck',
               'v_neck', 'bow', 'lapel', 'unknown'],
      },
      sleeve_length: {
        type: 'string',
        enum: ['long', 'three_quarter', 'short', 'sleeveless', 'unknown'],
      },
      cuff: {
        type: 'string',
        enum: ['separate_shirt_cuff', 'elastic', 'folded', 'none', 'unknown'],
      },
      pattern: {
        type: 'string',
        enum: ['solid', 'stripe', 'check', 'floral', 'other', 'unknown'],
      },
    },
    required: ['collar', 'sleeve_length', 'cuff', 'pattern'],
  },
};

const SPEC = STAGE === 'gate' ? GATE : ATTRS;

// ── Список артикулов ─────────────────────────────────────────────────────────
async function loadIds() {
  if (IDS_FILE) {
    return fs.readFileSync(IDS_FILE, 'utf8').split(/\s+/)
      .filter((x) => /^\d{5,}$/.test(x)).map(Number);
  }
  if (TOP > 0) {
    const { fetchCategory } = await import('../lib/mpstats.js');
    const d2 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const d1 = new Date(Date.now() - 91 * 86400000).toISOString().slice(0, 10);
    const cat = arg('category', 'Женщинам/Блузки и рубашки/Рубашка');
    console.log(`Беру топ-${TOP} категории «${cat}» за ${d1}..${d2}`);
    const { items } = await fetchCategory(cat, d1, d2, { maxRows: TOP, pageSize: 500 });
    return items.map((i) => i.sku).filter(Boolean).map(Number);
  }
  console.error('Укажите источник: --top N (из MPStats) или --ids файл');
  process.exit(1);
  return [];
}

// ── Контрольная точка ────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT_FILE = path.join(OUT_DIR, `vision-${STAGE}.jsonl`);

// Сделанными считаем только успешные строки. Карточка, упавшая по сети или
// по тайм-ауту модели, должна попасть в очередь повторно — иначе один сбой
// молча выбросит товар из выдачи.
function alreadyDone() {
  if (!flag('resume') || !fs.existsSync(OUT_FILE)) return new Set();
  const done = new Set();
  let retried = 0;
  for (const line of fs.readFileSync(OUT_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.error) { retried += 1; continue; }
      done.add(r.nmId);
    } catch (_) { /* битая строка */ }
  }
  if (retried) console.log(`Строк с ошибками в прошлом прогоне: ${retried} — будут повторены`);
  return done;
}

const append = (obj) => fs.appendFileSync(OUT_FILE, `${JSON.stringify(obj)}\n`);

// ── Загрузка изображений в base64 ────────────────────────────────────────────
async function imagesFor(card) {
  const urls = photoUrls(card, SPEC.photos, SIZE);
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20000) });
      if (r.ok) out.push(Buffer.from(await r.arrayBuffer()).toString('base64'));
    } catch (_) { /* пропускаем недостающий кадр */ }
  }
  return out;
}

// ── Основной цикл ────────────────────────────────────────────────────────────
const ids = await loadIds();
const done = alreadyDone();
const queue = ids.filter((id) => !done.has(id));

console.log(`Ступень: ${STAGE}   модель: ${MODEL}   фото: ${SPEC.photos}×${SIZE}`);
console.log(`Всего артикулов: ${ids.length}, уже сделано: ${done.size}, в очереди: ${queue.length}`);
console.log(`Кластер: ${CLUSTER} карточек, затем выгрузка модели из памяти`);
console.log(`Результат: ${OUT_FILE}\n`);

const m0 = await memory();
console.log(`Память на старте: свободно ${m0.freeGb.toFixed(1)} ГБ, своп ${Math.round(m0.swapUsedMb)} МБ`);

let processed = 0;
let errors = 0;
let gatePassed = 0;
const t0 = Date.now();

for (let start = 0; start < queue.length; start += CLUSTER) {
  const batch = queue.slice(start, start + CLUSTER);
  const nCluster = Math.floor(start / CLUSTER) + 1;
  const total = Math.ceil(queue.length / CLUSTER);
  console.log(`\n── кластер ${nCluster}/${total} (${batch.length} карточек) ──`);

  // Карточки тянем параллельно — это дёшево; модель дёргаем строго по одной.
  const cards = await mapLimit(batch, 6, (nm) => fetchCard(nm));

  for (let i = 0; i < batch.length; i += 1) {
    const nm = batch[i];
    const card = cards[i];
    if (!card || card.error) {
      append({ nmId: nm, stage: STAGE, error: 'карточка не найдена' });
      errors += 1;
      continue;
    }

    // На ступени гейта сначала бесплатный текстовый отсев.
    if (STAGE === 'gate') {
      const rej = hardRejectByOptions(card);
      if (rej.rejected) {
        append({ nmId: nm, stage: STAGE, textReject: rej, skippedVision: true });
        processed += 1;
        continue;
      }
    }

    const imgs = await imagesFor(card);
    if (!imgs.length) {
      append({ nmId: nm, stage: STAGE, error: 'фото не скачались' });
      errors += 1;
      continue;
    }

    try {
      const { data, ms, raw } = await ask(MODEL, SPEC.prompt, imgs, {
        schema: SPEC.schema, numPredict: SPEC.numPredict, numCtx: 2048,
      });
      if (!data) {
        append({ nmId: nm, stage: STAGE, error: 'ответ не JSON', raw: raw.slice(0, 200) });
        errors += 1;
      } else {
        if (STAGE === 'gate' && data.garment_type === 'shirt') gatePassed += 1;
        append({ nmId: nm, stage: STAGE, ms, vision: data,
          name: card.name, options: card.options });
        processed += 1;
      }
    } catch (err) {
      append({ nmId: nm, stage: STAGE, error: String(err.message || err) });
      errors += 1;
    }

    if ((i + 1) % 10 === 0) {
      const rate = (Date.now() - t0) / 1000 / Math.max(1, processed);
      process.stdout.write(`    ${start + i + 1}/${queue.length}  `
        + `${rate.toFixed(1)} с/карточку  ошибок ${errors}\n`);
    }
  }

  // ── Выгрузка и охлаждение между кластерами ────────────────────────────────
  await unload(MODEL);
  await sleep(COOL_MS);
  const still = await loaded();
  const mem = await memory();
  console.log(`  выгружено; в памяти Ollama: ${still.length ? still.map((s) => s.name).join(', ') : 'пусто'}`);
  console.log(`  память: свободно ${mem.freeGb.toFixed(1)} ГБ, своп ${Math.round(mem.swapUsedMb)} МБ`);

  if (start + CLUSTER < queue.length) {
    const ok = await waitForMemory({
      minFreeGb: MIN_FREE_GB, maxSwapMb: MAX_SWAP_MB,
      log: (s) => console.log(`  ${s}`),
    });
    if (!ok) {
      console.error('\nПрерываюсь: память не восстанавливается. '
        + 'Сделанное сохранено, продолжить можно с --resume.');
      break;
    }
  }
}

const mins = (Date.now() - t0) / 60000;
console.log(`\n${'─'.repeat(60)}`);
console.log(`Обработано ${processed}, ошибок ${errors}, за ${mins.toFixed(1)} мин`);
if (STAGE === 'gate') {
  console.log(`Прошло гейт как «shirt»: ${gatePassed}`);
  console.log(`Артикулы для разбора:  `
    + `node -e "require('fs').readFileSync('${OUT_FILE}','utf8').split('\\n')`
    + `.filter(Boolean).map(JSON.parse).filter(r=>r.vision?.garment_type==='shirt')`
    + `.forEach(r=>console.log(r.nmId))" > out/passed.txt`);
}
console.log(`Результат: ${OUT_FILE}`);
