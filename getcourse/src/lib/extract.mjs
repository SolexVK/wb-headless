// Extract the signed HLS master-playlist URL(s) for the video(s) embedded in a
// GetCourse lesson. The VideoHosting player iframe requests
//   /api/playlist/master/<video_hash>/<key_hash>?...&jwt=...
// automatically on load; we capture those from network traffic. A lesson may
// contain several videos (several player iframes) -> several master URLs.
import { log, warn, sleep } from './util.mjs';

export async function extractLessonVideos(page, lessonUrl, { settle = 7000 } = {}) {
  const masters = new Map(); // video_hash -> master url (first seen wins)
  const medias = new Map();  // video_hash -> a media url (fallback if no master)

  const onReq = (req) => {
    const u = req.url();
    let m = u.match(/\/api\/playlist\/master\/([a-f0-9]+)\//i);
    if (m && !masters.has(m[1])) masters.set(m[1], u);
    m = u.match(/\/api\/playlist\/media\/([a-f0-9]+)\//i);
    if (m && !medias.has(m[1])) medias.set(m[1], u);
  };
  page.on('request', onReq);
  try {
    await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    // Nudge any player that waits for interaction: try to play every <video>
    // in every frame, and click common big-play buttons.
    for (const f of page.frames()) {
      try {
        await f.evaluate(() => {
          document.querySelectorAll('video').forEach(v => { try { v.muted = true; v.play(); } catch (e) {} });
        });
        for (const sel of ['.vjs-big-play-button', 'button[aria-label*="lay"]', '.play', '.player-play']) {
          const el = await f.$(sel);
          if (el) await el.click({ timeout: 1500 }).catch(() => {});
        }
      } catch (e) {}
    }
    await sleep(settle);
  } finally {
    page.off('request', onReq);
  }

  const title = (await page.title().catch(() => '')) || '';
  const videos = [];
  for (const [hash, url] of masters) videos.push({ hash, url, kind: 'master' });
  // include media-only videos that never exposed a master
  for (const [hash, url] of medias) {
    if (!masters.has(hash)) videos.push({ hash, url, kind: 'media' });
  }
  if (!videos.length) warn(`no video playlist captured for lesson ${lessonUrl}`);
  else log(`  captured ${videos.length} video(s)`);
  return { title, videos };
}
