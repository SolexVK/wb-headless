// Preview a course structure without downloading anything.
// Usage: node src/map.mjs [startUrl]
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, login } from './lib/browser.mjs';
import { crawlCourse } from './lib/crawl.mjs';
import { log } from './lib/util.mjs';

// reuse the tiny .env loader from index.mjs by importing its side effect
import './lib/util.mjs';
function loadEnv() {
  for (const p of [path.join(process.cwd(), '.env'), path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}
loadEnv();

const EMAIL = process.env.GC_EMAIL, PASSWORD = process.env.GC_PASSWORD;
const START = process.argv[2] || process.env.GC_START_URL;
if (!EMAIL || !PASSWORD || !START) { console.error('Set GC_EMAIL, GC_PASSWORD, GC_START_URL'); process.exit(1); }

const { browser, ctx } = await openBrowser();
const page = await ctx.newPage();
try {
  if (!(await login(page, new URL(START).origin, EMAIL, PASSWORD))) throw new Error('login failed');
  const blocks = await crawlCourse(page, START);
  let total = 0;
  for (const [bi, b] of blocks.entries()) {
    console.log(`\nBLOCK ${bi + 1}: ${b.title}  (${b.lessons.length} lessons)`);
    b.lessons.forEach((l, i) => console.log(`   ${i + 1}. ${l.title}`));
    total += b.lessons.length;
  }
  console.log(`\nTOTAL: ${blocks.length} blocks, ${total} lessons`);
} finally {
  await browser.close();
}
