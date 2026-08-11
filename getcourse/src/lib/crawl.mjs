// Crawl a GetCourse "training" starting from any stream/lesson page and build an
// ordered map of blocks -> lessons. Works for arbitrary course structures: it
// follows every stream/view link reachable from the start page (the course's
// blocks/modules) but never the global stream/index (which would leak into other
// courses the account owns).
import { log, sleep } from './util.mjs';

export async function crawlCourse(page, startUrl) {
  const origin = new URL(startUrl).origin;
  const visited = new Set();
  const blocks = [];
  const queue = [startUrl];

  while (queue.length) {
    const url = queue.shift();
    const id = url.match(/stream\/view\/id\/(\d+)/)?.[1];
    if (!id || visited.has(id)) continue;
    visited.add(id);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1200);

    const data = await page.evaluate(() => {
      const title = (document.querySelector('h1, .training-title, .stream-title')?.textContent
        || document.title).replace(/\s+/g, ' ').trim();
      const lessons = [...document.querySelectorAll('a[href*="/teach/control/lesson/view"]')]
        .map(a => ({ href: a.href, text: (a.textContent || '').replace(/\s+/g, ' ').trim() }));
      const streams = [...document.querySelectorAll('a[href*="/teach/control/stream/view"]')]
        .map(a => a.href);
      return { title, lessons, streams };
    });

    // dedup lessons by id, preserve on-page order
    const seen = new Set();
    const lessons = data.lessons.filter(l => {
      const k = l.href.match(/lesson\/view\/id\/(\d+)/)?.[1];
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map(l => ({ id: l.href.match(/id\/(\d+)/)[1], url: l.href, title: l.text }));

    blocks.push({ id, url, title: data.title, lessons });
    log(`block ${id} "${data.title}": ${lessons.length} lessons`);

    for (const s of data.streams) {
      const sid = s.match(/stream\/view\/id\/(\d+)/)?.[1];
      if (sid && !visited.has(sid)) queue.push(s);
    }
  }
  return blocks;
}
