// report-sellers.js — топ-10 продавцов, топ-10 артикулов и новинки топ-продавцов.
//
//   MPSTATS_TOKEN=xxx node report-sellers.js
//
// Пишет reports/sellers/<дата>/data.json + README.md

import { mkdirSync, writeFileSync } from 'node:fs';
import { analyzeAll } from './lib/sellerNewProducts.js';

const SPECS = [
  { query: 'рубашка в клетку женская', category: 'Женщинам/Блузки и рубашки/Рубашка', label: 'Женская', cls: 'w' },
  { query: 'рубашка в клетку мужская', category: 'Мужчинам/Рубашки', label: 'Мужская', cls: 'm' },
];
const newWithinDays = Number(process.env.NEW_WITHIN_DAYS) || 60;
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const D2 = iso(Date.now() - day);
const D1 = iso(Date.now() - (newWithinDays + 1) * day);

const rub = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(v) || 0));
const short = (s, n = 40) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const sellerCell = (name, url) => (url ? `[${short(name, 28)}](${url})` : short(name, 28));
const clsTag = (c) => `${c.sleeve === 'long' ? 'длин.' : c.sleeve === 'short' ? 'кор.' : '—'}/${c.season === 'winter' ? 'осень-зима' : c.season === 'summer' ? 'лето' : '—'}`;

console.error(`[sellers] запуск · окно новинок ${newWithinDays} дн.`);
const analyses = await analyzeAll(SPECS, { newWithinDays, d1: D1, d2: D2, topN: 10 });
analyses.forEach((a, i) => { a.label = SPECS[i].label; });

const today = new Date().toISOString().slice(0, 10);
const outDir = `reports/sellers/${today}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/data.json`, JSON.stringify(analyses, null, 2));

const L = [];
L.push('# 🏪 Топ-продавцы, топ-артикулы и их новинки — «рубашка в клетку»');
L.push('');
L.push(`> **Дата:** ${today} · **Источник:** MPStats API (оценочные данные) · **Окно новинок:** ${newWithinDays} дн. (с ${analyses[0].cutoff}).`);
L.push('>');
L.push('> **Метод.** Топ-10 продавцов и топ-10 артикулов — из топ-выдачи MPStats по запросу. Новинки продавца — из базовой категории рубашек с фильтром по `supplier_id` и сортировкой по дате появления (ловит новинки, даже если они ещё не в топе выдачи).');
L.push('');
L.push('## 📊 Сводка');
L.push('');
L.push('| Запрос | Категория | Новинок у топ-10 | Из них «в клетку» | Выручка новинок ₽ |');
L.push('|---|---|--:|--:|--:|');
for (const a of analyses) {
  L.push(`| ${a.query} | ${a.categoryPath} | ${a.totals.newProducts} | ${a.totals.newPlaid} | ${rub(a.totals.newRevenue)} |`);
}
L.push('');
L.push('---');
L.push('');

for (const a of analyses) {
  L.push(`## 🔎 «${a.query}»`);
  L.push('');
  L.push(`Период данных: ${a.period.d1} … ${a.period.d2}. Категория новинок: \`${a.categoryPath}\`.`);
  L.push('');

  // Топ-10 продавцов
  L.push('### 🏆 Топ-10 продавцов (по выручке в выдаче)');
  L.push('');
  L.push('| # | Продавец (витрина) | Бренд | В топе выдачи | Выручка ₽ | Доля | Рубашек в категории | Новинок 60 дн. (в клетку) |');
  L.push('|--:|---|---|--:|--:|--:|--:|--:|');
  a.topSellers.forEach((s, i) => {
    const sn = a.sellerNews[i];
    L.push(`| ${i + 1} | ${sellerCell(s.seller, s.url)} | ${short(s.brand || '—', 16)} | ${s.cardsInTop} | ${rub(s.revenue)} | ${s.sharePct}% | ${sn.totalShirtsInCategory ?? '—'} | **${sn.newCount}** (${sn.newPlaidCount}) |`);
  });
  L.push('');

  // Топ-10 артикулов
  L.push('### 🥇 Топ-10 артикулов (по выручке)');
  L.push('');
  L.push('| # | SKU (карточка) | Название | Продавец (витрина) | Цена ₽ | Продаж | Выручка ₽ | Рейтинг | Вышла | 🆕 |');
  L.push('|--:|---|---|---|--:|--:|--:|--:|---|:--:|');
  a.topArticles.forEach((c) => {
    const isNew = c.firstDate && c.firstDate >= a.cutoff ? '🆕' : '';
    L.push(`| ${c.rank} | [${c.sku}](${c.cardUrl}) | ${short(c.name, 30)} | ${sellerCell(c.seller, c.sellerUrl)} | ${rub(c.price)} | ${rub(c.sales)} | ${rub(c.revenue)} | ${c.rating || '—'} | ${c.firstDate || '—'} | ${isNew} |`);
  });
  L.push('');

  // Новинки топ-продавцов
  L.push('### 🆕 Новинки топ-10 продавцов за 2 месяца');
  L.push('');
  const withNews = a.sellerNews.filter((s) => s.newCount > 0);
  const without = a.sellerNews.filter((s) => s.newCount === 0);
  if (!withNews.length) L.push('_Ни один из топ-10 не завёл новинок за период._');
  for (const s of withNews) {
    L.push(`#### ${sellerCell(s.seller, s.url)} — ${s.newCount} новинок (${s.newPlaidCount} «в клетку»), выручка ${rub(s.newRevenue)} ₽`);
    L.push('');
    L.push('| SKU (карточка) | Название | Вышла | Рукав/сезон | В клетку | Цена ₽ | Продаж | Выручка ₽ |');
    L.push('|---|---|---|---|:--:|--:|--:|--:|');
    for (const c of s.news.slice(0, 15)) {
      L.push(`| [${c.sku}](${c.cardUrl}) | ${short(c.name, 34)} | ${c.firstDate} | ${clsTag(c.cls)} | ${c.isPlaid ? '🔲' : ''} | ${rub(c.price)} | ${rub(c.sales)} | ${rub(c.revenue)} |`);
    }
    if (s.news.length > 15) L.push(`\n_…и ещё ${s.news.length - 15} карточек (см. data.json)._`);
    L.push('');
  }
  if (without.length) {
    L.push(`> 💤 Без новинок за период (работают на текущих карточках): ${without.map((s) => sellerCell(s.seller, s.url)).join(', ')}.`);
    L.push('');
  }
  L.push('---');
  L.push('');
}

L.push('## ⚠️ Оговорки');
L.push('');
L.push('- Данные MPStats — **оценочные**. «Выручка в выдаче» (топ-продавцы/артикулы) считается по топ-100 выдачи запроса; «выручка новинок» — по базовой категории рубашек за период. Это разные базы, не суммировать вслепую.');
L.push('- Новинки продавца берутся из **категории рубашек** целиком (не только «в клетку») — колонка «в клетку» 🔲 и «рукав/сезон» помогают отфильтровать. Классификация по названию.');
L.push('- Ссылки: артикул → карточка WB; продавец → витрина `wildberries.ru/seller/{supplierId}`.');
L.push('');
L.push(`_Сгенерировано \`report-sellers.js\`. Данные: \`${outDir}/data.json\`._`);

writeFileSync(`${outDir}/README.md`, L.join('\n') + '\n');
console.error(`[sellers] готово: ${outDir}/README.md, ${outDir}/data.json · новинок: ${analyses.map((a) => a.totals.newProducts).join(' / ')}`);
