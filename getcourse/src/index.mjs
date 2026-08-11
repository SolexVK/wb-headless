#!/usr/bin/env node
// GetCourse course downloader — orchestrator.
//
// Flow: login -> crawl blocks/lessons -> for each lesson capture the signed
// playlist URL(s) -> download + remux each video to a gapless .mp4, laid out on
// disk mirroring the site (block folders, lesson-titled files).
//
// Config comes from the environment (see .env.example). Safe to re-run: lessons
// whose .mp4 already exists are skipped, so an interrupted run resumes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, login } from './lib/browser.mjs';
import { crawlCourse } from './lib/crawl.mjs';
import { extractLessonVideos } from './lib/extract.mjs';
import { downloadToMp4 } from './lib/hls.mjs';
import { log, warn, sanitize, pad } from './lib/util.mjs';

// --- minimal .env loader (no external dependency) ---
function loadEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', '.env'), path.join(process.cwd(), '.env')]) {
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

const EMAIL = process.env.GC_EMAIL;
const PASSWORD = process.env.GC_PASSWORD;
const START = process.argv[2] || process.env.GC_START_URL;
const OUT = path.resolve(process.env.GC_OUTPUT || './output');
const CONCURRENCY = +(process.env.GC_CONCURRENCY || 10);
const LIMIT = +(process.env.GC_LIMIT || 0); // 0 = no limit (download all lessons)

if (!EMAIL || !PASSWORD || !START) {
  console.error('Missing config. Set GC_EMAIL, GC_PASSWORD and GC_START_URL (or pass the start URL as an argument).');
  process.exit(1);
}

const origin = new URL(START).origin;

const { browser, ctx } = await openBrowser();
const page = await ctx.newPage();
const summary = [];
try {
  if (!(await login(page, origin, EMAIL, PASSWORD))) throw new Error('login failed — check credentials');

  log('crawling course structure...');
  const blocks = await crawlCourse(page, START);
  const totalLessons = blocks.reduce((n, b) => n + b.lessons.length, 0);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'course_map.json'), JSON.stringify(blocks, null, 2));
  log(`course: ${blocks.length} blocks, ${totalLessons} lessons -> ${OUT}`);

  let done = 0;
  outer:
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const blockDir = path.join(OUT, `${pad(bi + 1)} ${sanitize(block.title)}`);
    for (let li = 0; li < block.lessons.length; li++) {
      if (LIMIT && done >= LIMIT) { log(`reached GC_LIMIT=${LIMIT}, stopping`); break outer; }
      done++;
      const lesson = block.lessons[li];
      log(`\n[${bi + 1}.${li + 1}] ${lesson.title}`);
      const { title, videos } = await extractLessonVideos(page, lesson.url);
      const lessonTitle = sanitize(title || lesson.title);
      const base = `${pad(li + 1)} ${lessonTitle}`;

      if (!videos.length) {
        summary.push({ block: block.title, lesson: lesson.title, status: 'no-video' });
        continue;
      }
      for (let vi = 0; vi < videos.length; vi++) {
        const suffix = videos.length > 1 ? ` (${vi + 1})` : '';
        const outFile = path.join(blockDir, `${base}${suffix}.mp4`);
        if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
          log(`  skip (exists): ${path.basename(outFile)}`);
          summary.push({ block: block.title, lesson: lesson.title, file: outFile, status: 'skipped' });
          continue;
        }
        try {
          const r = await downloadToMp4(videos[vi].url, outFile, { concurrency: CONCURRENCY });
          const mb = (r.bytes / 1048576).toFixed(1);
          log(`  saved ${path.basename(outFile)} — ${r.height}p, ${Math.floor(r.seconds / 60)}m${r.seconds % 60}s, ${mb} MB`);
          summary.push({ block: block.title, lesson: lesson.title, file: outFile, status: 'ok', height: r.height, seconds: r.seconds, mb: +mb });
        } catch (e) {
          warn(`  download failed: ${e.message}`);
          summary.push({ block: block.title, lesson: lesson.title, status: 'error', error: e.message });
        }
      }
    }
  }
} finally {
  await browser.close();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'download_report.json'), JSON.stringify(summary, null, 2));
  const ok = summary.filter(s => s.status === 'ok').length;
  const skip = summary.filter(s => s.status === 'skipped').length;
  const bad = summary.filter(s => s.status === 'error' || s.status === 'no-video').length;
  log(`\nDONE: ${ok} downloaded, ${skip} skipped, ${bad} problems. Report: ${path.join(OUT, 'download_report.json')}`);
}
