// scripts/wb-top-keywords.mjs — CLI инструмента [1] «ТОП по ключевой фразе».
// Логика — в lib/wbTopKeywords.js (её же зовёт оркестратор напрямую).
//
// Конвейер: вся выдача WB по фразе за период (MPStats) → отсев выручки <100k →
// «глубокие» фильтры по словам в названии (группы-признаки + исключения, + правило
// «безхвостых» сильных артикулов) → метрические фильтры → сортировка по выручке →
// топ-N последним шагом. Требует MPSTATS_TOKEN в окружении.
//
// Параметры (обычно собираются в предполётном диалоге и передаются флагами):
//   --query "рубашка в полоску женская"       ключевая фраза (обязательна)
//   --period 30            | --d1 2026-06-01 --d2 2026-06-30   период метрик
//   --top 100             топ-N (10/100/500…), применяется последним
//   --group "крой=прямой,приталенн"           группа-признак (можно несколько раз)
//   --group "воротник=стойка"
//   --exclude "оверсайз,волан"                общий список слов-исключений
//   --price-min 800 --price-max 3000          коридор по СРЕДНЕЙ ЦЕНЕ ПРОДАЖИ
//   --revenue-floor 100000                    порог первичного отсева (дефолт 100000)
//   --exception-rank 20                       «сопоставимо с ТОП-N» для безхвостых
//   --min-rating 4.5 --min-reviews 50 --min-sales 100        доп. метрические пороги
//   --our 167477208                           наш артикул — исключить из выдачи
//   --max-rows 2000                           предохранитель на размер выборки
//   --out reports-output/top.json | --nmids-only    вывод
//   --pick                нумерованная таблица-пикер в stdout (шаг выбора [1]→[2])
//
//   # сцепка каскада [1]→[2] — РУЧНОЙ выбор (по умолчанию):
//   node scripts/wb-top-keywords.mjs --query "платье" --top 20 --pick   # смотрим таблицу
//   # → называем нужные nmId и запускаем [2]:
//   node scripts/wb-cards-compare.mjs --our 167477208 --rivals <nmId,nmId,…>
//
//   # (авто-топ-K без выбора, если явно нужен): --nmids-only | wb-cards-compare

import { topByKeywords, formatHtml, formatPickTable, embedThumbnails } from '../lib/wbTopKeywords.js';
import { buildFacetFilters } from '../lib/wbFacets.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Парсер: одиночные --flag value и повторяемый --group.
const argv = process.argv.slice(2);
const opt = {};
const groupsRaw = [];
const facetsRaw = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const n = argv[i + 1];
  const val = n && !n.startsWith('--') ? (i++, n) : true;
  if (k === 'group') groupsRaw.push(val);
  else if (k === 'facet') facetsRaw.push(val); // повторяемый: --facet cut=приталенный
  else opt[k] = val;
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const numOpt = (v) => (v == null ? undefined : Number(v));
const listOpt = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

if (!opt.query) {
  log('Не задана ключевая фраза. Пример:');
  log('  MPSTATS_TOKEN=xxx node scripts/wb-top-keywords.mjs --query "рубашка в полоску женская" \\');
  log('    --period 30 --top 100 --group "крой=прямой,приталенн" --group "воротник=стойка" \\');
  log('    --exclude "оверсайз,волан" --price-min 800 --price-max 3000');
  process.exit(2);
}

// Период: либо --d1/--d2, либо пресет --period N (дней; d2=вчера).
let d1 = opt.d1;
let d2 = opt.d2;
if (!d1 && !d2 && opt.period) {
  const days = Number(opt.period) || 30;
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  d2 = iso(Date.now() - day);
  d1 = iso(Date.now() - (days + 1) * day);
}

// Группы-признаки: "крой=прямой,приталенн" → { key:'крой', any:['прямой','приталенн'] }.
const groups = groupsRaw
  .map((g) => {
    const [key, vals] = String(g).split('=');
    return { key: (key || '').trim(), any: listOpt(vals) || [] };
  })
  .filter((g) => g.any.length);

// Фасеты: "--facet cut=приталенный" (+ back-compat "--pattern полоска" → pattern=…).
const facetSel = {};
for (const raw of facetsRaw) {
  const [k, v] = String(raw).split('=');
  if (k && v) facetSel[k.trim()] = v.trim().toLowerCase();
}
if (opt.pattern) facetSel.pattern = String(opt.pattern).trim().toLowerCase();
const facets = buildFacetFilters(facetSel);

const filters = clean({
  revenueFloor: numOpt(opt['revenue-floor']),
  exceptionRank: numOpt(opt['exception-rank']),
  priceMin: numOpt(opt['price-min']),
  priceMax: numOpt(opt['price-max']),
  minRating: numOpt(opt['min-rating']),
  minReviews: numOpt(opt['min-reviews']),
  minSales: numOpt(opt['min-sales']),
  deep: (groups.length || opt.exclude) ? { groups, exclude: listOpt(opt.exclude) || [] } : undefined,
  facets: facets.length ? facets : undefined,
});

try {
  const res = await topByKeywords({
    query: opt.query,
    d1,
    d2,
    filters,
    our: opt.our,
    topN: numOpt(opt.top) ?? null,
    maxRows: numOpt(opt['max-rows']),
  });

  const exCount = res.rivals.filter((r) => r.matchType === 'exception').length;
  log(`Фраза: «${res.query}» | период ${res.period.d1}…${res.period.d2}`);
  log(`Выдача: всего ${res.total}${res.capped ? ' (упёрлись в предохранитель)' : ''}, разобрано ${res.fetched}, после отсева <${res.filters.revenueFloor}₽ — ${res.pool}.`);
  if (groups.length) log(`Порог «безхвостых» (ТОП-${filters.exceptionRank ?? 20} по выручке): ${res.exceptionRevenueThreshold}₽.`);
  if (res.enrich) log(`Добор карточек: ${res.enrich.enriched} новых + ${res.enrich.fromCache} из кэша, без card.json — ${res.enrich.misses}.`);
  log(`Итог: ${res.rivals.length} шт.${exCount ? ` (из них по исключению «безхвостые»: ${exCount})` : ''}`);
  if (res.uncertainPattern) log(`🟡 Признак не определён у ${res.uncertainPattern} карточек (нет тега — кандидаты на визуальную проверку).`);

  // JSON-вывод пишем ДО вшивания фото — иначе base64 картинок раздует файл.
  // --nmids-only: голый JSON-массив nmId (для пайпа в wb-cards-compare).
  const payload = opt['nmids-only'] ? res.rivals.map((r) => r.nmId) : res;
  const out = JSON.stringify(payload, null, opt['nmids-only'] ? 0 : 2);
  if (opt.out) {
    // --out без значения → авто-имя с фразой и датой; со значением → как задано.
    const outPath = typeof opt.out === 'string' ? opt.out : reportPath(opt.query, 'json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out);
    log(`Записано: ${outPath}`);
  }
  // stdout: приоритет у --pick (таблица ручного выбора конкурентов для [2]); иначе
  // JSON, если его не подавляет --out/--html (чтобы не зашумлять) или это --nmids-only.
  if (opt.pick) {
    process.stdout.write(formatPickTable(res) + '\n');
  } else if (!opt.out && (!opt.html || opt['nmids-only'])) {
    process.stdout.write(out + '\n');
  }

  // --html: самодостаточный HTML-отчёт (можно открыть в браузере).
  // Имя файла содержит ключевую фразу и дату выдачи — чтобы легко искать потом.
  if (opt.html) {
    const htmlPath = typeof opt.html === 'string' ? opt.html : reportPath(opt.query, 'html');
    // По умолчанию вшиваем фото карточек (data-URI) — без доп. запросов к MPStats,
    // только скачивание миниатюр с CDN WB. --no-images отключает (быстрее/легче).
    if (!opt['no-images']) {
      log(`Скачиваю фото карточек (${res.rivals.length} шт.)…`);
      await embedThumbnails(res.rivals);
      const ok = res.rivals.filter((r) => r.thumbData).length;
      log(`  вшито изображений: ${ok}/${res.rivals.length}`);
    }
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, formatHtml(res));
    log(`HTML-отчёт: ${htmlPath}`);
  }
} catch (err) {
  log(`Ошибка: ${err?.message || err}`);
  if (/MPSTATS_TOKEN/.test(String(err?.message))) {
    log('Задай токен MPSTATS: MPSTATS_TOKEN=... (заголовок X-Mpstats-TOKEN).');
  }
  process.exit(1);
}

function clean(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }

// Имя файла отчёта: reports-output/<фраза>_<дата>.<ext> — с датой выдачи, чтобы
// потом легко искать. Фразу сохраняем кириллицей (читаемо), чистим только опасные
// для ФС символы и пробелы.
function reportPath(query, ext) {
  const slug = String(query || 'top')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'top';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `reports-output/${slug}_${date}.${ext}`;
}
