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
//
//   # сцепка каскада [1]→[2]:
//   node scripts/wb-top-keywords.mjs --query "платье" --top 4 --nmids-only | \
//     node scripts/wb-cards-compare.mjs --our 167477208

import { topByKeywords, formatHtml, embedThumbnails } from '../lib/wbTopKeywords.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Парсер: одиночные --flag value и повторяемый --group.
const argv = process.argv.slice(2);
const opt = {};
const groupsRaw = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const n = argv[i + 1];
  const val = n && !n.startsWith('--') ? (i++, n) : true;
  if (k === 'group') groupsRaw.push(val);
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

const filters = clean({
  revenueFloor: numOpt(opt['revenue-floor']),
  exceptionRank: numOpt(opt['exception-rank']),
  priceMin: numOpt(opt['price-min']),
  priceMax: numOpt(opt['price-max']),
  minRating: numOpt(opt['min-rating']),
  minReviews: numOpt(opt['min-reviews']),
  minSales: numOpt(opt['min-sales']),
  deep: (groups.length || opt.exclude) ? { groups, exclude: listOpt(opt.exclude) || [] } : undefined,
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
  log(`Итог: ${res.rivals.length} шт.${exCount ? ` (из них по исключению «безхвостые»: ${exCount})` : ''}`);

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
  } else if (!opt.html || opt['nmids-only']) {
    // Если задан только --html, JSON в stdout не льём (чтобы не зашумлять).
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
