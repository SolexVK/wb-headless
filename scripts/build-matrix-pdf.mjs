// scripts/build-matrix-pdf.mjs — PDF (альбом) с матрицей NMID × склад (шт) + Сумма ₽.
// Читает reports-output/burned-matrix-*.json. Запуск: node scripts/build-matrix-pdf.mjs [json] [out.pdf]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const num = (n) => (n ? Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ') : '');
const rub = (n) => (n ? Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽' : '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const SHORT = {
  'Электросталь': 'Электросталь', 'СПБ Шушары': 'Шушары', 'Краснодар': 'Краснодар', 'Тула': 'Тула',
  'Невинномысск': 'Невинномысск', 'Самара (Новосемейкино)': 'Самара', 'Сарапул': 'Сарапул',
  'Рязань (Тюшевское)': 'Рязань', 'Коледино': 'Коледино', 'Екатеринбург - Перспективная 14': 'Екатеринбург',
  'Воронеж': 'Воронеж', 'Волгоград': 'Волгоград', 'Владимир': 'Владимир', 'Пенза': 'Пенза',
  'Котовск': 'Котовск', 'Тверь': 'Тверь', 'Красный Бор': 'Красный Бор', 'Подольск': 'Подольск',
};

function latest() {
  const dir = path.join(ROOT, 'reports-output');
  const f = fs.readdirSync(dir).filter((x) => /^burned-matrix-.*\.json$/.test(x))
    .map((x) => path.join(dir, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!f.length) throw new Error('нет burned-matrix-*.json');
  return f[0];
}

function build(j) {
  const wh = j.warehouses;
  const whHead = wh.map((n) => `<th class="wh"><span>${esc(SHORT[n] || n)}</span></th>`).join('');
  const body = j.rows.map((r) => `<tr>
    <td class="nm">${r.nmId}</td>
    <td class="vc">${esc(r.vendorCode)}</td>
    ${wh.map((n) => `<td class="q">${num(r.perWh[n])}</td>`).join('')}
    <td class="tot">${num(r.totalQty)}</td>
    <td class="sum">${rub(r.sumRub)}</td>
  </tr>`).join('');
  const totRow = `<tr class="grand">
    <td class="nm" colspan="2">ИТОГО · ${j.rows.length} арт.</td>
    ${wh.map((n) => `<td class="q">${num(j.warehouseTotals[n])}</td>`).join('')}
    <td class="tot">${num(j.grandQty)}</td>
    <td class="sum">${rub(j.grandSumRub)}</td>
  </tr>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 8mm 7mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body{ font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; color:#241238; }
  .hd{ display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2px solid #7B2CBF; padding-bottom:5px; margin-bottom:6px; }
  .hd .t{ font-size:15px; font-weight:800; color:#481173; }
  .hd .t span{ color:#E63946; }
  .hd .m{ font-size:8px; color:#6A5A85; margin-top:2px; }
  .hd .g{ text-align:right; font-size:8px; color:#6A5A85; }
  .hd .g b{ font-size:13px; color:#E63946; display:block; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  thead{ display:table-header-group; }
  th,td{ border:0.5px solid #D8CCEC; font-size:6.4px; padding:1px 2px; overflow:hidden; }
  th{ background:#481173; color:#fff; font-weight:700; text-align:center; vertical-align:bottom; height:52px; }
  th.wh span{ writing-mode:vertical-rl; transform:rotate(180deg); white-space:nowrap; font-size:6.6px; margin:0 auto; }
  th.nm,th.vc,th.tot,th.sum{ vertical-align:middle; }
  th.sum{ background:#E63946; }
  td.nm{ font-size:6.3px; text-align:left; color:#333; }
  td.vc{ font-size:6px; text-align:left; color:#555; white-space:nowrap; }
  td.q{ text-align:right; color:#241238; }
  td.tot{ text-align:right; font-weight:700; background:#F3EEFA; }
  td.sum{ text-align:right; font-weight:700; color:#B01722; background:#FDECEE; white-space:nowrap; }
  tr:nth-child(even) td{ background:#FAF7FD; }
  tr:nth-child(even) td.tot{ background:#EEE7F8; } tr:nth-child(even) td.sum{ background:#FBE4E7; }
  tr.grand td{ background:#D9C7EE; font-weight:800; font-size:6.8px; border-top:1.5px solid #7B2CBF; }
  tr.grand td.sum{ background:#E63946; color:#fff; }
  col.nm{ width:34px; } col.vc{ width:60px; } col.wh{ width:auto; } col.tot{ width:28px; } col.sum{ width:52px; }
  </style></head><body>
  <div class="hd">
    <div>
      <div class="t">Потери сгоревшего товара по артикулам <span>(NMID × склад)</span></div>
      <div class="m">Снимок ${esc(j.snapshotAt.slice(0, 10))} · себестоимость ${j.cost} ₽/ед · ${esc(j.basis)}</div>
    </div>
    <div class="g">итого потерь<b>${rub(j.grandSumRub)}</b>${num(j.grandQty)} ед · ${j.rows.length} арт. · ${wh.length} складов</div>
  </div>
  <table>
    <colgroup>
      <col class="nm"><col class="vc">${wh.map(() => '<col class="wh">').join('')}<col class="tot"><col class="sum">
    </colgroup>
    <thead><tr>
      <th class="nm">NMID</th><th class="vc">Артикул</th>${whHead}<th class="tot">Итого шт</th><th class="sum">Сумма ₽</th>
    </tr></thead>
    <tbody>${body}${totRow}</tbody>
  </table>
  </body></html>`;
}

async function main() {
  const jsonPath = process.argv[2] || latest();
  const outPdf = process.argv[3] || jsonPath.replace(/\.json$/, '.pdf').replace('burned-matrix-', 'burned-matrix-pdf-');
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const html = build(j);
  fs.writeFileSync(outPdf.replace(/\.pdf$/, '.html'), html);
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: outPdf, format: 'A4', landscape: true, printBackground: true });
  await browser.close();
  log('✓ PDF:', outPdf);
  process.stdout.write(outPdf + '\n');
}
main().catch((e) => { log('✗ ' + e.message); process.exit(1); });
