// scripts/refresh-wb-docs.mjs — перечитать все страницы из docs/wb-api/pages.json
// и сохранить снимки. Используется еженедельным workflow и вручную.
//
//   node scripts/refresh-wb-docs.mjs
//
// Возвращает код 0, если все страницы забраны успешно; 1 — если хотя бы одну
// не удалось прочитать (например, не пройден антибот) — тогда снимок НЕ
// перезаписывается пустышкой.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDocText } from './fetch-wb-docs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const cfg = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/wb-api/pages.json'), 'utf8')
);

let failed = 0;
for (const p of cfg.pages) {
  process.stderr.write(`\n=== ${p.url} → ${p.out} ===\n`);
  try {
    const { text, passed } = await fetchDocText(p.url);
    if (!passed || text.length < 800) {
      process.stderr.write('  ⚠ контент неполный (антибот?) — снимок НЕ обновлён\n');
      failed += 1;
      continue;
    }
    const out = path.join(root, p.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const header =
      `<!-- Источник: ${p.url} -->\n` +
      `<!-- Снимок официальной документации WB API. Обновляется скриптом ` +
      `scripts/refresh-wb-docs.mjs. Дату см. в истории git. -->\n\n`;
    fs.writeFileSync(out, header + text + '\n');
    process.stderr.write(`  ✓ сохранено (${text.length} символов)\n`);
  } catch (err) {
    process.stderr.write(`  ✗ ошибка: ${err?.message || err}\n`);
    failed += 1;
  }
}

process.stderr.write(`\nГотово. Ошибок: ${failed} из ${cfg.pages.length}.\n`);
process.exit(failed ? 1 : 0);
