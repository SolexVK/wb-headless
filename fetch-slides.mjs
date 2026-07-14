// Тянет слайды карточек-новинок (после фильтра) для визуального разбора воронки.
// Для каждой новинки с продажами: до 10 миниатюр (c246x328) в ленту + 1 крупный
// первый слайд (big) для обложки. Пишет slides/manifest.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchCard, downloadSlides, characteristics, slideUrls } from './lib/wbCards.js';

const data = JSON.parse(readFileSync('reports/new-products/2026-07-14/data.json', 'utf8'));
const DIR = 'reports/new-products/2026-07-14/slides';
const N_SLIDES = Number(process.env.N_SLIDES) || 10;

const out = [];
for (const a of data) {
  const targets = a.news.filter((c) => c.sales > 0); // все новинки с продажами (после фильтра)
  for (const c of targets) {
    process.stderr.write(`[slides] ${a.query} · ${c.sku} ${c.name.slice(0, 28)} … `);
    const card = await fetchCard(c.sku);
    if (!card) { process.stderr.write('НЕТ КАРТОЧКИ\n'); out.push({ query: a.query, sku: c.sku, name: c.name, ok: false }); continue; }
    // до 10 миниатюр в ленту (tm — компактно для PDF) + средний первый слайд для обложки
    const strip = await downloadSlides(card, DIR, N_SLIDES, 'tm');
    const hero = await downloadSlides(card, DIR, 1, 'c516x688');
    const chars = characteristics(card);
    process.stderr.write(`host ${card._host}, лента ${strip.length}, обложка ${hero.length ? 'ok' : '—'}\n`);
    out.push({
      query: a.query,
      sku: c.sku,
      name: c.name,
      cls: c.cls,
      firstDate: c.firstDate,
      price: c.price,
      sales: c.sales,
      revenue: c.revenue,
      pics: c.pics,
      hasVideo: c.hasVideo,
      rating: c.rating,
      cardUrl: c.cardUrl,
      sellerUrl: c.sellerUrl,
      brand: c.brand,
      host: card._host,
      photoCount: card?.media?.photo_count ?? null,
      description: (card.description || '').slice(0, 600),
      characteristics: chars,
      heroFile: hero[0]?.path || null,
      stripFiles: strip.map((s) => s.path),
      slideUrls: slideUrls(card, N_SLIDES, 'big'),
    });
  }
}
writeFileSync(`${DIR}/manifest.json`, JSON.stringify(out, null, 2));
const okCards = out.filter((x) => x.stripFiles?.length).length;
const totalSlides = out.reduce((s, x) => s + (x.stripFiles?.length || 0), 0);
process.stderr.write(`[slides] готово: ${okCards}/${out.length} карточек, ${totalSlides} миниатюр, манифест ${DIR}/manifest.json\n`);
