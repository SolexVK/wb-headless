// Reusable course-download engine shared by the CLI (index.mjs) and the web
// server (web/). It performs the whole flow and reports progress through an
// onEvent callback so any front-end can render live status.
//
// Events emitted (evt.type):
//   'login'         { ok }
//   'course'        { blocks:[{title,lessons}], totalLessons }
//   'lesson-start'  { bi, li, title }
//   'video-start'   { bi, li, vi, count }
//   'video-progress'{ bi, li, vi, done, total }
//   'video-done'    { bi, li, vi, file, height, seconds, bytes }
//   'lesson-skip'   { bi, li, file }
//   'lesson-error'  { bi, li, error }
//   'done'          { ok, skipped, problems, output }
//   'log'           { message }
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, login } from './lib/browser.mjs';
import { crawlCourse } from './lib/crawl.mjs';
import { extractLessonVideos } from './lib/extract.mjs';
import { downloadToMp4 } from './lib/hls.mjs';
import { sanitize, pad } from './lib/util.mjs';

export async function runCourseDownload(opts) {
  const {
    email, password, startUrl,
    output,
    concurrency = 10,
    limit = 0,
    plan = null, // optional pre-selected blocks [{title, lessons:[{title,url}]}] — skips crawl
    onEvent = () => {},
    shouldCancel = () => false,
  } = opts;

  const emit = (type, data = {}) => { try { onEvent({ type, ...data }); } catch (e) {} };
  const log = (message) => emit('log', { message });

  const originSource = startUrl || plan?.[0]?.lessons?.[0]?.url || plan?.[0]?.url;
  if (!email || !password || !originSource) throw new Error('email, password and a course URL (or selection) are required');
  const origin = new URL(originSource).origin;
  const OUT = path.resolve(output || './output');

  const summary = { ok: 0, skipped: 0, problems: 0, items: [], output: OUT };
  const { browser, ctx } = await openBrowser();
  const page = await ctx.newPage();
  try {
    const okLogin = await login(page, origin, email, password);
    emit('login', { ok: okLogin });
    if (!okLogin) throw new Error('login failed — check GetCourse credentials');

    let blocks;
    if (plan && plan.length) {
      log('Скачивание выбранных уроков...');
      blocks = plan;
    } else {
      log('Обход структуры курса...');
      blocks = await crawlCourse(page, startUrl);
    }
    const totalLessons = blocks.reduce((n, b) => n + (b.lessons ? b.lessons.length : 0), 0);
    if (totalLessons === 0) {
      throw new Error('Не найдено уроков для скачивания. Скопируйте адрес страницы курса со списком уроков — обычно вида .../teach/control/stream/view/id/ЧИСЛО (или адрес конкретного урока .../lesson/view/id/ЧИСЛО).');
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'course_map.json'), JSON.stringify(blocks, null, 2));
    emit('course', { blocks: blocks.map(b => ({ title: b.title, lessons: b.lessons.length })), totalLessons });

    let done = 0;
    outer:
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const blockDir = path.join(OUT, `${pad(bi + 1)} ${sanitize(block.title)}`);
      for (let li = 0; li < block.lessons.length; li++) {
        if (shouldCancel()) { log('Отменено пользователем'); break outer; }
        if (limit && done >= limit) { log(`Достигнут лимит ${limit}`); break outer; }
        done++;
        const lesson = block.lessons[li];
        emit('lesson-start', { bi, li, title: lesson.title });

        let extracted;
        try {
          extracted = await extractLessonVideos(page, lesson.url);
        } catch (e) {
          summary.problems++;
          summary.items.push({ block: block.title, lesson: lesson.title, status: 'error', error: e.message });
          emit('lesson-error', { bi, li, error: e.message });
          continue;
        }
        const lessonTitle = sanitize(extracted.title || lesson.title);
        const base = `${pad(li + 1)} ${lessonTitle}`;
        const videos = extracted.videos;
        if (!videos.length) {
          summary.problems++;
          summary.items.push({ block: block.title, lesson: lesson.title, status: 'no-video' });
          emit('lesson-error', { bi, li, error: 'видео не найдено' });
          continue;
        }

        for (let vi = 0; vi < videos.length; vi++) {
          if (shouldCancel()) { log('Отменено пользователем'); break outer; }
          const suffix = videos.length > 1 ? ` (${vi + 1})` : '';
          const outFile = path.join(blockDir, `${base}${suffix}.mp4`);
          if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
            summary.skipped++;
            summary.items.push({ block: block.title, lesson: lesson.title, file: outFile, status: 'skipped' });
            emit('lesson-skip', { bi, li, vi, file: outFile });
            continue;
          }
          emit('video-start', { bi, li, vi, count: videos.length });
          try {
            const r = await downloadToMp4(videos[vi].url, outFile, {
              concurrency,
              onProgress: (p) => emit('video-progress', { bi, li, vi, done: p.done, total: p.total }),
            });
            summary.ok++;
            summary.items.push({ block: block.title, lesson: lesson.title, file: outFile, status: 'ok', height: r.height, seconds: r.seconds, mb: +(r.bytes / 1048576).toFixed(1) });
            emit('video-done', { bi, li, vi, file: outFile, height: r.height, seconds: r.seconds, bytes: r.bytes });
          } catch (e) {
            summary.problems++;
            summary.items.push({ block: block.title, lesson: lesson.title, status: 'error', error: e.message });
            emit('lesson-error', { bi, li, error: e.message });
          }
        }
      }
    }
  } finally {
    await browser.close();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'download_report.json'), JSON.stringify(summary.items, null, 2));
    emit('done', { ok: summary.ok, skipped: summary.skipped, problems: summary.problems, output: OUT });
  }
  return summary;
}
