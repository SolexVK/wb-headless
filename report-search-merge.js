// report-search-merge.js — собрать топ-N по нескольким поисковым фразам через
// MPStats, объединить, дедуп по SKU, отсортировать. Сохраняет JSON для дальнейшей
// аналитики. Печатает сводку и превью.
//
// Запуск:
//   MPSTATS_TOKEN=xxx node report-search-merge.js "блузка женская" "блузка женская с жабо" ...
//   период (env): MERGE_D1 / MERGE_D2 (по умолч. последние ~90 дн.); MERGE_PER (100)
//   имя файла (env): MERGE_SLUG
import fs from 'fs';
import path from 'path';
import { mergePhrases } from './lib/searchPhrases.js';

function period90() {
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 91 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { d1: iso(start), d2: iso(end) };
}

async function main() {
  const phrases = process.argv.slice(2).filter(Boolean);
  if (!phrases.length) { console.error('Укажите фразы: node report-search-merge.js "фраза1" "фраза2" ...'); process.exit(1); }
  const d1 = process.env.MERGE_D1 || period90().d1;
  const d2 = process.env.MERGE_D2 || period90().d2;
  const perPhrase = Number(process.env.MERGE_PER) || 100;

  console.error(`Фраз: ${phrases.length} · период ${d1}…${d2} · топ-${perPhrase} по каждой`);
  const res = await mergePhrases(phrases, { d1, d2, perPhrase, onPhrase: (p, n) => console.error(`  «${p}» → ${n}`) });

  console.log(`\nПериод: ${d1} … ${d2}`);
  console.log('По фразам:');
  res.byPhrase.forEach((b) => console.log(`  «${b.phrase}»: ${b.found} (в выдаче WB: ${b.totalInSearch})`));
  console.log(`\nУникальных после объединения/дедупа: ${res.uniqueCount}`);
  const dist = {}; res.items.forEach((i) => (dist[i.phraseHits] = (dist[i.phraseHits] || 0) + 1));
  console.log('Распределение по числу фраз:', JSON.stringify(dist));
  console.log('\nТОП-15 (релевантность → выручка):');
  res.items.slice(0, 15).forEach((i) => console.log(`  ${String(i.rank).padStart(3)}. фраз:${i.phraseHits} | ${(i.revenue / 1e6).toFixed(1)}М ₽ | ${String(i.sales).padStart(5)} шт | ${String(i.price).padStart(5)}₽ | ${(i.brand || '—').slice(0, 16).padEnd(16)} | ${i.name.slice(0, 40)}`));

  const outDir = path.resolve('reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const slug = process.env.MERGE_SLUG || `search-merge-${d1}_${d2}`;
  const out = path.join(outDir, `${slug}.json`);
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  console.log('\nСохранено:', out);
}

main().catch((e) => { console.error('Ошибка:', e?.stack || e?.message || e); process.exit(1); });
