// Crawl a GetCourse "training" starting from a course page and build an ordered
// map of blocks -> lessons. Accepts several URL forms:
//   - a block/module page  …/teach/control/stream/view/id/N   (best; crawls all
//     sibling blocks of that course)
//   - a single lesson page …/teach/control/lesson/view/id/M   (that one lesson)
//   - any other page that directly lists lessons              (used as-is)
// It never follows the global stream index, so it won't leak into other courses.
import { log, sleep } from './util.mjs';

async function scan(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1200);
  return page.evaluate(() => {
    const title = (document.querySelector('h1, .training-title, .stream-title')?.textContent
      || document.title).replace(/\s+/g, ' ').trim();
    const lessons = [...document.querySelectorAll('a[href*="/teach/control/lesson/view"]')]
      .map(a => ({ href: a.href, text: (a.textContent || '').replace(/\s+/g, ' ').trim() }));
    const streams = [...document.querySelectorAll('a[href*="/teach/control/stream/view"]')]
      .map(a => a.href);
    return { title, lessons, streams };
  });
}

function dedupLessons(list) {
  const seen = new Set();
  return list.filter(l => {
    const k = l.href.match(/lesson\/view\/id\/(\d+)/)?.[1];
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(l => ({ id: l.href.match(/id\/(\d+)/)[1], url: l.href, title: l.text }));
}

export async function crawlCourse(page, startUrl) {
  // Single lesson URL -> one-lesson "course".
  const lessonId = startUrl.match(/lesson\/view\/id\/(\d+)/)?.[1];
  if (lessonId) {
    const d = await scan(page, startUrl);
    const title = d.title || 'Урок';
    log(`single lesson ${lessonId}: ${title}`);
    return [{ id: 'lesson-' + lessonId, url: startUrl, title, lessons: [{ id: lessonId, url: startUrl, title }] }];
  }

  const startIsStream = /stream\/view\/id\/\d+/.test(startUrl);
  const visitedStreams = new Set();
  const visitedUrls = new Set();
  const blocks = [];
  const queue = [startUrl];

  while (queue.length) {
    const url = queue.shift();
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);
    const sid = url.match(/stream\/view\/id\/(\d+)/)?.[1];
    if (sid) { if (visitedStreams.has(sid)) continue; visitedStreams.add(sid); }

    const d = await scan(page, url);
    const lessons = dedupLessons(d.lessons);
    if (lessons.length) {
      blocks.push({ id: sid || url, url, title: d.title, lessons });
      log(`block ${sid || url} "${d.title}": ${lessons.length} lessons`);
    }
    // Only fan out to sibling blocks when we started from a real block page —
    // this crawls the whole course but avoids mass-crawling from a list/root page.
    if (startIsStream) {
      for (const s of d.streams) {
        const ssid = s.match(/stream\/view\/id\/(\d+)/)?.[1];
        if (ssid && !visitedStreams.has(ssid)) queue.push(s);
      }
    }
  }
  return blocks;
}
