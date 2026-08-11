// Browser layer: launch Chromium (portable across this sandbox and a Mac Mini)
// and log into a GetCourse account. The browser is used only for authenticated
// navigation and for capturing the player's signed playlist URLs — the actual
// video download is done separately with curl + ffmpeg.
import { chromium } from 'playwright';
import { log, warn, sleep } from './util.mjs';

// Launch options are assembled from the environment so the same code runs:
//  - here (behind an egress proxy that resets TLS1.3/HTTP2 for anti-bot CDNs)
//  - on a normal Mac (no proxy, system-managed Playwright Chromium)
export function launchOptions() {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-quic',
    '--disable-background-networking',
    '--disable-component-update',
  ];
  // TLS/HTTP2 workaround: needed behind the sandbox egress proxy, harmless
  // elsewhere. Disable by setting GC_NO_TLS_WORKAROUND=1 if it ever gets in the way.
  if (!process.env.GC_NO_TLS_WORKAROUND) {
    args.push('--ssl-version-max=tls1.2', '--disable-http2');
  }
  const opts = { headless: process.env.GC_HEADFUL ? false : true, args };
  // Route through an HTTPS proxy only if one is configured (sandbox); on a Mac
  // HTTPS_PROXY is normally unset and Chromium connects directly.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) opts.proxy = { server: proxy };
  // Use an explicit Chromium binary if provided, else Playwright's managed one.
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  return opts;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export async function openBrowser() {
  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true, // some player sub-resources are proxy re-terminated
  });
  return { browser, ctx };
}

// Log in via the GetCourse system login page. Returns true on success.
export async function login(page, origin, email, password) {
  await page.goto(origin + '/cms/system/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  // The login widget renders two email/password pairs (login + hidden "logined"
  // form); fill the first visible pair and submit with Enter.
  for (const e of await page.$$('input[name="email"], input[type="email"]')) {
    if (await e.isVisible().catch(() => false)) { await e.fill(email); break; }
  }
  let pw = null;
  for (const p of await page.$$('input[name="password"], input[type="password"]')) {
    if (await p.isVisible().catch(() => false)) { await p.fill(password); pw = p; break; }
  }
  if (!pw) { warn('login: password field not found'); return false; }
  await pw.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const url = page.url();
  const ok = !/\/cms\/system\/login/.test(url);
  log('login', ok ? 'OK ->' : 'FAILED, still at', url);
  return ok;
}
