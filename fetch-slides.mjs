// Скачивает слайды топ-новинок обоих запросов + характеристики (для визуального разбора воронки).
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchCard, downloadSlides, characteristics, slideUrls } from './lib/wbCards.js';

const data = JSON.parse(readFileSync('reports/new-products/2026-07-14/data.json', 'utf8'));
const DIR = 'reports/new-products/2026-07-14/slides';
const PER_QUERY = Number(process.env.SLIDE_TOP) || 4; // сколько новинок на запрос

const out = [];
for (const a of data) {
  const targets = a.news.filter((c) => c.sales > 0).slice(0, PER_QUERY);
  for (const c of targets) {
    process.stderr.write(`[slides] ${a.query} · ${c.sku} ${c.name.slice(0, 30)} … `);
    const card = await fetchCard(c.sku);
    if (!card) { process.stderr.write('НЕТ КАРТОЧКИ\n'); out.push({ query: a.query, sku: c.sku, name: c.name, ok: false }); continue; }
    const saved = await downloadSlides(card, DIR, 5);
    const chars = characteristics(card);
    process.stderr.write(`host ${card._host}, ${saved.length} слайдов, ${chars.length} характеристик\n`);
    out.push({
      query: a.query,
      sku: c.sku,
      name: c.name,
      firstDate: c.firstDate,
      price: c.price,
      sales: c.sales,
      revenue: c.revenue,
      pics: c.pics,
      hasVideo: c.hasVideo,
      rating: c.rating,
      host: card._host,
      photoCount: card?.media?.photo_count ?? null,
      description: (card.description || '').slice(0, 600),
      characteristics: chars,
      slideUrls: slideUrls(card, 5),
      files: saved.map((s) => s.path),
    });
  }
}
writeFileSync(`${DIR}/manifest.json`, JSON.stringify(out, null, 2));
process.stderr.write(`[slides] готово: ${out.filter((x) => x.files?.length).length}/${out.length} карточек, манифест ${DIR}/manifest.json\n`);
