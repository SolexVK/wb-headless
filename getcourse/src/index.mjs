#!/usr/bin/env node
// GetCourse course downloader — command-line entry point.
//
// Logs in, crawls a course's blocks/lessons and downloads every lesson video as
// a gapless .mp4 in a folder tree mirroring the site. Safe to re-run: existing
// files are skipped so an interrupted run resumes.
//
// Config comes from the environment / .env (see .env.example). The download
// engine itself lives in run.mjs and is shared with the web UI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCourseDownload } from './run.mjs';
import { log } from './lib/util.mjs';

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

const opts = {
  email: process.env.GC_EMAIL,
  password: process.env.GC_PASSWORD,
  startUrl: process.argv[2] || process.env.GC_START_URL,
  output: process.env.GC_OUTPUT || './output',
  concurrency: +(process.env.GC_CONCURRENCY || 10),
  limit: +(process.env.GC_LIMIT || 0),
  onEvent: (evt) => { if (evt.type === 'log') log(evt.message); },
};

if (!opts.email || !opts.password || !opts.startUrl) {
  console.error('Missing config. Set GC_EMAIL, GC_PASSWORD and GC_START_URL (or pass the start URL as an argument).');
  process.exit(1);
}

// human-friendly console rendering of engine events
opts.onEvent = (evt) => {
  switch (evt.type) {
    case 'log': log(evt.message); break;
    case 'login': log('login', evt.ok ? 'OK' : 'FAILED'); break;
    case 'course': log(`course: ${evt.blocks.length} blocks, ${evt.totalLessons} lessons`); break;
    case 'lesson-start': log(`[${evt.bi + 1}.${evt.li + 1}] ${evt.title}`); break;
    case 'video-progress':
      if (evt.done === evt.total || evt.done % 25 === 0) log(`   segments ${evt.done}/${evt.total}`);
      break;
    case 'video-done': log(`   saved ${path.basename(evt.file)} — ${evt.height}p, ${Math.floor(evt.seconds / 60)}m${evt.seconds % 60}s, ${(evt.bytes / 1048576).toFixed(1)} MB`); break;
    case 'lesson-skip': log(`   skip (exists): ${path.basename(evt.file)}`); break;
    case 'lesson-error': log(`   problem: ${evt.error}`); break;
    case 'done': log(`\nDONE: ${evt.ok} downloaded, ${evt.skipped} skipped, ${evt.problems} problems -> ${evt.output}`); break;
  }
};

await runCourseDownload(opts);
