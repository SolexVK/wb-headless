// report-new-products.js — отчёт по товарам-новинкам на WB по поисковым запросам.
//
// Запуск (токен MPStats — в переменной окружения):
//   MPSTATS_TOKEN=xxx node report-new-products.js
//   MPSTATS_TOKEN=xxx node report-new-products.js "рубашка в клетку женская" "рубашка в клетку мужская"
//   MPSTATS_TOKEN=xxx NEW_WITHIN_DAYS=60 node report-new-products.js
//
// Пишет: reports/new-products/<дата>/data.json  и  README.md (отчёт).

import { mkdirSync, writeFileSync } from 'node:fs';
import { analyzeQueries } from './lib/newProductsAnalysis.js';

const DEFAULT_QUERIES = ['рубашка в клетку женская', 'рубашка в клетку мужская'];
const queries = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_QUERIES;
const newWithinDays = Number(process.env.NEW_WITHIN_DAYS) || 60;
// Фильтр ниши: длинный рукав + осень/зима (можно отключить FILTER=all).
const filter = process.env.FILTER || 'long-autumn-winter';
const FILTER_LABEL = filter === 'long-autumn-winter' ? 'длинный рукав · осень/зима' : filter;

// Окно метрик = окно новинки: d2 = вчера (сегодня API 422), d1 = d2 − newWithinDays.
// Так «продажи за период» покрывают те же ~2 месяца, что и порог новинки.
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const D2 = iso(Date.now() - day);
const D1 = iso(Date.now() - (newWithinDays + 1) * day);

const rub = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(v) || 0));
const pct = (v) => `${(Number(v) || 0).toFixed(1)}%`;
const short = (s, n = 42) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const wbLink = (sku) => `https://www.wildberries.ru/catalog/${sku}/detail.aspx`;
// Кликабельный бренд: витрина продавца (по supplierId), иначе поиск по бренду.
const brandCell = (c) => {
  const name = short(c.brand || '—', 18);
  if (c.sellerUrl) return `[${name}](${c.sellerUrl})`;
  if (c.brandUrl) return `[${name}](${c.brandUrl})`;
  return name;
};

function funnelBlock(a) {
  // Агрегированная воронка ниши по модели WB (KB 01).
  const news = a.news;
  const lines = [];
  lines.push('| Этап воронки | Вес в органике¹ | Метрика новинок (медиана) |');
  lines.push('|---|---|---|');
  const med = (f) => {
    const arr = news.map(f).filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
    if (!arr.length) return '—';
    return arr[Math.floor(arr.length / 2)];
  };
  lines.push(`| 👁 Показы / видимость | верх воронки | search_visibility ≈ ${med((c) => c.searchVisibility)} · category_visibility ≈ ${med((c) => c.categoryVisibility)} |`);
  lines.push(`| 🖱 Клик (CTR) | +25% | ср. позиция в выдаче ≈ ${med((c) => c.searchPosAvg)} (органика ≈ ${med((c) => c.searchOrganicPosAvg)}) |`);
  lines.push('| 🛒 Корзина | 0% (фактор убран) | — |');
  lines.push(`| 📦 Заказ | +25% | продаж/день ≈ ${med((c) => c.salesPerDay)} |`);
  lines.push(`| ✅ Выкуп | +50% (главный) | выкуп ≈ ${med((c) => c.buyout)}% |`);
  return lines.join('\n');
}

function querySection(a) {
  const L = [];
  L.push(`## 🔎 Запрос: «${a.query}»`);
  L.push('');
  L.push(`- **Период данных (продажи/выручка):** ${a.period.d1} … ${a.period.d2} (${a.newWithinDays} дн. ≈ 2 мес.)`);
  L.push(`- **Порог новинки:** карточка вышла на WB не раньше **${a.cutoff}**`);
  if (a.filter) {
    L.push(`- **Фильтр ниши:** ${FILTER_LABEL} — из ${a.counts.fetchedRaw} карточек топа оставлено **${a.counts.fetched}**, отсеяно ${a.counts.excluded} (короткий рукав / явное лето). Классификация по названию карточки.`);
  }
  L.push(`- **Карточек в отфильтрованной выдаче:** ${a.counts.fetched}, из них с продажами — ${a.counts.withSales}`);
  L.push(`- **Новинок (после фильтра):** **${a.counts.news}** (с продажами — ${a.counts.newsWithSales}); «старых» карточек — ${a.counts.established}`);
  L.push('');
  L.push('### Доля новинок в нише (по запросу)');
  L.push('');
  L.push('| Показатель | Новинки | Вся ниша (топ) | Доля новинок |');
  L.push('|---|---:|---:|---:|');
  L.push(`| Выручка за период, ₽ | ${rub(a.newsShare.revenue)} | ${rub(a.niche.revenue)} | ${pct(a.newsShare.revenuePct)} |`);
  L.push(`| Продажи, шт | ${rub(a.newsShare.sales)} | ${rub(a.niche.sales)} | ${pct(a.newsShare.salesPct)} |`);
  L.push(`| Карточек | ${a.counts.news} | ${a.counts.fetched} | ${pct(a.newsShare.countPct)} |`);
  L.push('');

  // 1. Продажи новинок
  L.push('### 1) 💰 Продажи новинок');
  L.push('');
  L.push('| # | SKU (ссылка) | Название | Бренд (ссылка) | Рукав/сезон | Вышла | Цена ₽ | Продаж, шт | Выручка ₽ | Выкуп % |');
  L.push('|--:|---|---|---|---|---|--:|--:|--:|--:|');
  a.news.forEach((c, i) => {
    const cls = `${c.cls.sleeve === 'long' ? 'длин.' : c.cls.sleeve === 'short' ? 'кор.' : '—'}/${c.cls.season === 'winter' ? 'осень-зима' : c.cls.season === 'summer' ? 'лето' : '—'}`;
    L.push(`| ${i + 1} | [${c.sku}](${c.cardUrl}) | ${short(c.name, 34)} | ${brandCell(c)} | ${cls} | ${c.firstDate} | ${rub(c.price)} | ${rub(c.sales)} | ${rub(c.revenue)} | ${c.buyout || '—'} |`);
  });
  L.push('');
  if (a.excludedSample && a.excludedSample.length) {
    L.push(`<details><summary>Отсеяно фильтром новинок: ${a.counts.excluded} карточек (короткий рукав / лето) — показать примеры</summary>`);
    L.push('');
    L.push('| SKU | Название | Причина |');
    L.push('|---|---|---|');
    for (const c of a.excludedSample) {
      const reason = c.cls.sleeve === 'short' ? 'короткий рукав' : c.cls.season === 'summer' ? 'летняя' : '—';
      L.push(`| [${c.sku}](${c.cardUrl}) | ${short(c.name, 40)} | ${reason} |`);
    }
    L.push('');
    L.push('</details>');
    L.push('');
  }

  // Траектории выхода (кривая старта)
  const withTraj = a.trajectories.filter((t) => (t.daily || []).length);
  if (withTraj.length) {
    L.push('**Кривая выхода топ-новинок** (продажи по дням, спарклайн ▁▂▃▅▇):');
    L.push('');
    for (const t of withTraj) {
      const vals = t.daily.map((d) => d.sales);
      L.push(`- \`${t.sku}\` ${short(t.name, 32)} — ${spark(vals)}  (Σ ${rub(sum(vals))} шт за ${vals.length} дн.)`);
    }
    L.push('');
  }

  // 2. Листинг + бенчмарк
  L.push('### 2) 🖼 Листинг (контент карточки) + планка ниши');
  L.push('');
  L.push('Медианы: **топ-20 ниши** (планка входа) против **новинок**.');
  L.push('');
  const b = a.benchmark;
  const nb = a.newsBenchmark || {};
  L.push('| Метрика листинга | Топ-20 (планка) | Новинки | Комментарий |');
  L.push('|---|--:|--:|---|');
  L.push(`| Фото на карточке | ${b.pics} | ${nb.pics ?? '—'} | глубина визуального ряда |`);
  L.push(`| Видео, % карточек | ${b.hasVideoShare}% | ${nb.hasVideoShare ?? '—'}% | видео поднимает CTR |`);
  L.push(`| 3D, % карточек | ${b.has3dShare}% | ${nb.has3dShare ?? '—'}% | редкий, но плюс |`);
  L.push(`| Длина описания | ${b.descriptionLength} | ${nb.descriptionLength ?? '—'} | SEO-текст |`);
  L.push(`| SEO-слов в ядре | ${b.searchWords} | ${nb.searchWords ?? '—'} | охват запросов |`);
  L.push(`| Рейтинг | ${b.rating} | ${nb.rating ?? '—'} | доверие / соц. док-во |`);
  L.push(`| Отзывов | ${b.comments} | ${nb.comments ?? '—'} | набирается со временем |`);
  L.push('');

  // 3. Визуальная воронка
  L.push('### 3) 🔻 Визуальная воронка (модель ранжирования WB)');
  L.push('');
  L.push(funnelBlock(a));
  L.push('');
  L.push('¹ Веса вклада в органику по методике из базы знаний (KB 01): клик +25%, корзина 0% (фактор убран), заказ +25%, **выкуп +50% — основной фактор роста и фиксации позиции**.');
  L.push('');
  L.push('Пофакторно по новинкам (верх → низ воронки):');
  L.push('');
  L.push('| SKU | Видимость | Ср.позиция | На рекламе | Фото | Рейтинг | Продаж/день | Выкуп % |');
  L.push('|---|--:|--:|:--:|--:|--:|--:|--:|');
  for (const f of a.funnel) {
    L.push(`| ${f.sku} | ${f.searchVisibility || '—'} | ${f.searchPosAvg || '—'} | ${f.onAd ? '📣' : '—'} | ${f.pics || '—'} | ${f.rating || '—'} | ${f.salesPerDay.toFixed(1)} | ${f.buyout || '—'} |`);
  }
  L.push('');

  // 4. Конкурентный анализ
  L.push('### 4) 🥊 Конкурентный анализ');
  L.push('');
  L.push(`- **Продавцов в топе:** ${a.niche.sellers} · **брендов:** ${a.niche.brands}`);
  L.push(`- **Концентрация (HHI по выручке продавцов):** ${a.niche.hhiSellers} — ${hhiVerdict(a.niche.hhiSellers)}`);
  L.push(`- **Медианная цена ниши:** ${rub(a.niche.medianPrice)} ₽ · **медианный выкуп:** ${a.niche.medianBuyout}%`);
  L.push('');
  L.push('**Топ-10 продавцов по выручке:**');
  L.push('');
  L.push('| # | Продавец (ссылка) | Карточек | Выручка ₽ | Доля |');
  L.push('|--:|---|--:|--:|--:|');
  a.competition.topSellers.forEach((s, i) => {
    const share = a.niche.revenue ? (s.revenue / a.niche.revenue) * 100 : 0;
    const name = s.url ? `[${short(s.key, 30)}](${s.url})` : short(s.key, 30);
    L.push(`| ${i + 1} | ${name} | ${s.cards} | ${rub(s.revenue)} | ${pct(share)} |`);
  });
  L.push('');
  L.push('**Топ-10 брендов по выручке:**');
  L.push('');
  L.push('| # | Бренд (ссылка) | Карточек | Выручка ₽ | Доля |');
  L.push('|--:|---|--:|--:|--:|');
  a.competition.topBrands.forEach((s, i) => {
    const share = a.niche.revenue ? (s.revenue / a.niche.revenue) * 100 : 0;
    const name = s.url ? `[${short(s.key, 26)}](${s.url})` : short(s.key, 26);
    L.push(`| ${i + 1} | ${name} | ${s.cards} | ${rub(s.revenue)} | ${pct(share)} |`);
  });
  L.push('');
  L.push('**Ценовые сегменты (по отфильтрованной выдаче):**');
  L.push('');
  L.push('| Сегмент, ₽ | Карточек | Продаж, шт | Выручка ₽ |');
  L.push('|---|--:|--:|--:|');
  for (const s of a.competition.segments) {
    L.push(`| ${rub(s.from)} – ${rub(s.to)} | ${s.cards} | ${rub(s.sales)} | ${rub(s.revenue)} |`);
  }
  L.push('');
  L.push('**Топ-12 карточек ниши (для сравнения новинок с лидерами):**');
  L.push('');
  L.push('| # | SKU (ссылка) | Название | Бренд (ссылка) | Вышла | Цена ₽ | Выручка ₽ | Отзывов | 🆕 |');
  L.push('|--:|---|---|---|---|--:|--:|--:|:--:|');
  a.competition.topByRevenue.forEach((c, i) => {
    const isNew = c.firstDate && c.firstDate >= a.cutoff ? '🆕' : '';
    L.push(`| ${i + 1} | [${c.sku}](${c.cardUrl}) | ${short(c.name, 30)} | ${brandCell(c)} | ${c.firstDate} | ${rub(c.price)} | ${rub(c.revenue)} | ${rub(c.comments)} | ${isNew} |`);
  });
  L.push('');
  L.push('---');
  L.push('');
  return L.join('\n');
}

function sum(arr) {
  return arr.reduce((s, x) => s + (Number(x) || 0), 0);
}
function spark(vals) {
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(1, ...vals);
  return vals.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('');
}
function hhiVerdict(h) {
  if (h < 0.15) return 'ниша раздроблена, вход открыт';
  if (h < 0.25) return 'умеренная концентрация';
  return 'высокая концентрация, есть доминаторы';
}

// ---- main ----
const today = new Date().toISOString().slice(0, 10);
console.error(`[new-products] запросы: ${queries.join(' | ')} · окно новинки: ${newWithinDays} дн. · фильтр: ${filter}`);
const analyses = await analyzeQueries(queries, { newWithinDays, d1: D1, d2: D2, filter });

const outDir = `reports/new-products/${today}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/data.json`, JSON.stringify(analyses, null, 2));

const head = [];
head.push('# 🆕 Товары-новинки на Wildberries — «рубашка в клетку»');
head.push('');
head.push(`> **Дата отчёта:** ${today} · **Источник:** MPStats API (оценочные данные) · **Метод:** топ-выдача по поисковому запросу.`);
head.push('>');
head.push(`> **Новинка** = карточка, впервые появившаяся на WB за последние **${newWithinDays} дней**. Продажи/выручка — за то же окно (≈2 мес.).`);
if (analyses[0]?.filter) {
  head.push('>');
  head.push(`> 🧣 **Фильтр:** ${FILTER_LABEL}. Из топ-выдачи убраны карточки с коротким рукавом и явным «летним» позиционированием (классификация по названию).`);
}
head.push('');
head.push('## 📊 Сводка по запросам');
head.push('');
head.push('| Запрос | Отфильтровано | Новинок | С продажами | Выручка новинок ₽ | Доля выручки | Медианная цена ₽ |');
head.push('|---|--:|--:|--:|--:|--:|--:|');
for (const a of analyses) {
  head.push(`| ${a.query} | ${a.counts.fetched}/${a.counts.fetchedRaw} | ${a.counts.news} | ${a.counts.newsWithSales} | ${rub(a.newsShare.revenue)} | ${pct(a.newsShare.revenuePct)} | ${rub(a.niche.medianPrice)} |`);
}
head.push('');
head.push('---');
head.push('');

const body = analyses.map(querySection).join('\n');

const foot = [
  '## ⚠️ Оговорки',
  '',
  '- Данные MPStats — **оценочные** (восстановление продаж по остаткам/выкупам), не отчёт из кабинета продавца. Годятся для сравнения и ранжирования.',
  '- «Ниша по запросу» = топ-выдача MPStats (до 100 карточек), а не весь каталог. Доли считаются внутри этого топа.',
  '- **Корзина, конверсия по слайду, «покупают также», принадлежность %** — не отдаются этим API; берутся из Wildbox/Gem (слой B методики).',
  '- Веса воронки — реверс-инжиниринг из базы знаний (KB 01), а не официальная формула WB.',
  '- **Выкуп %** MPStats отдаёт как оценку **на уровне ниши** (поэтому у карточек он почти одинаков ~38–39%), а не индивидуально по каждой карточке — используйте как ориентир ниши.',
  '',
  `_Сгенерировано \`report-new-products.js\`. Данные: \`${outDir}/data.json\`._`,
].join('\n');

const report = head.join('\n') + body + '\n' + foot + '\n';
writeFileSync(`${outDir}/README.md`, report);
console.error(`[new-products] готово: ${outDir}/README.md (${report.length} симв.), ${outDir}/data.json`);
