// Browser-driven GetCourse discovery for the UI: list the courses on a school's
// "Список тренингов" page, and fetch a chosen course's full block/lesson tree.
// Operations are serialized (one headless browser at a time) to bound resources.
import { openBrowser, login } from '../../src/lib/browser.mjs';
import { crawlCourse } from '../../src/lib/crawl.mjs';

let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Accept a bare domain, a full school URL, or the stream page URL.
export function schoolStreamUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Укажите адрес школы GetCourse');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  return `${u.origin}/teach/control/stream`;
}

async function withSession(email, password, origin, fn) {
  if (!email || !password) throw new Error('Нужны email и пароль GetCourse');
  const { browser, ctx } = await openBrowser();
  const page = await ctx.newPage();
  try {
    const ok = await login(page, origin, email, password);
    if (!ok) throw new Error('Не удалось войти в GetCourse — проверьте email и пароль');
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

export function listCourses(email, password, schoolInput) {
  const streamUrl = schoolStreamUrl(schoolInput);
  const origin = new URL(streamUrl).origin;
  return serialize(() => withSession(email, password, origin, async (page) => {
    await page.goto(streamUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    const courses = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href*="/teach/control/stream/view/id/"]').forEach(a => {
        const raw = (a.textContent || '').replace(/\s+/g, ' ').trim();
        const nice = (a.querySelector('.stream-title, .training-title')?.textContent || raw).replace(/\s+/g, ' ').trim();
        const title = (nice.split(/\s+\d+\s+урок/)[0] || nice).trim() || raw.slice(0, 80) || 'Курс';
        out.push({ url: a.href, title, subtitle: raw });
      });
      return out;
    });
    const seen = new Set();
    return courses.filter(c => { const k = c.url.match(/id\/(\d+)/)?.[1]; if (!k || seen.has(k)) return false; seen.add(k); return true; });
  }));
}

export function courseTree(email, password, courseUrl) {
  const origin = new URL(courseUrl).origin;
  return serialize(() => withSession(email, password, origin, async (page) => {
    const blocks = await crawlCourse(page, courseUrl);
    return blocks.map((b, bi) => ({
      index: bi, id: b.id, title: b.title,
      lessons: b.lessons.map((l, li) => ({ index: li, id: l.id, title: l.title, url: l.url })),
    }));
  }));
}
