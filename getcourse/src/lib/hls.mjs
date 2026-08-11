// HLS layer: turn a signed GetCourse/VideoHosting playlist URL into a single
// gapless .mp4 using curl (download) + ffmpeg (remux, stream-copy, no re-encode).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, pool, log, warn } from './util.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CURL = process.env.CURL || 'curl';

// Fetch a URL as text via curl (curl honours HTTPS_PROXY/NO_PROXY from the env).
async function curlText(url) {
  const r = await run(CURL, ['-sS', '--fail', '--retry', '3', '--retry-delay', '2', '-A', UA, url]);
  if (r.code !== 0) throw new Error(`curl failed (${r.code}) for ${url.slice(0, 100)}: ${r.stderr.slice(0, 200)}`);
  return r.stdout;
}

async function curlToFile(url, file) {
  const r = await run(CURL, ['-sS', '--fail', '--retry', '4', '--retry-delay', '2', '-A', UA, '-o', file, url]);
  return r.code === 0;
}

// Parse an HLS master playlist into variant streams. Returns [] if it is not a
// master (i.e. it is already a media playlist with segments).
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const attr = lines[i].slice('#EXT-X-STREAM-INF:'.length);
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(attr);
      const bw = /BANDWIDTH=(\d+)/.exec(attr);
      const pathway = /PATHWAY-ID="([^"]*)"/.exec(attr);
      // the URL is the next non-comment line
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('#') || lines[j].trim() === '')) j++;
      if (j < lines.length) {
        variants.push({
          width: res ? +res[1] : 0,
          height: res ? +res[2] : 0,
          bandwidth: bw ? +bw[1] : 0,
          pathway: pathway ? pathway[1] : '',
          url: new URL(lines[j].trim(), baseUrl).href,
        });
      }
    }
  }
  return variants;
}

// Choose the highest-resolution variant, preferring the "gcore" pathway when
// several CDNs offer the same resolution.
export function pickBest(variants) {
  const byRes = [...variants].sort((a, b) =>
    (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const top = byRes[0];
  const sameRes = variants.filter(v => v.height === top.height);
  return sameRes.find(v => /gcore/i.test(v.pathway)) || top;
}

// Extract ordered segment URLs from a media playlist.
export function parseMedia(text, baseUrl) {
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(u => new URL(u, baseUrl).href);
}

// Resolve a playlist URL (master or media) to the media playlist we will download.
export async function resolveMedia(playlistUrl) {
  const text = await curlText(playlistUrl);
  const variants = parseMaster(text, playlistUrl);
  if (variants.length) {
    const best = pickBest(variants);
    log(`  master: ${variants.length} variants, picked ${best.width}x${best.height} (${best.pathway || 'default'})`);
    const mediaText = await curlText(best.url);
    return { mediaUrl: best.url, mediaText, height: best.height };
  }
  // already a media playlist
  return { mediaUrl: playlistUrl, mediaText: text, height: 0 };
}

// Download all segments of a media playlist and remux to a single gapless mp4.
// Returns { ok, height, seconds, bytes }.
export async function downloadToMp4(playlistUrl, outFile, { concurrency = 10 } = {}) {
  const { mediaUrl, mediaText, height } = await resolveMedia(playlistUrl);
  const segUrls = parseMedia(mediaText, mediaUrl);
  if (!segUrls.length) throw new Error('no segments in media playlist');
  const seconds = (mediaText.match(/#EXTINF:([0-9.]+)/g) || [])
    .reduce((s, m) => s + parseFloat(m.slice(8)), 0);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  try {
    // download segments in parallel
    const fails = [];
    await pool(segUrls, async (url, idx) => {
      const f = path.join(work, `seg${String(idx).padStart(6, '0')}.ts`);
      for (let t = 0; t < 4; t++) {
        if (await curlToFile(url, f)) return;
      }
      fails.push(idx);
    }, concurrency);
    if (fails.length) throw new Error(`failed to download ${fails.length}/${segUrls.length} segments`);

    // rebuild a LOCAL media playlist that references the downloaded files, then
    // let ffmpeg's HLS demuxer stitch them into one continuous timeline.
    let localIdx = 0;
    const localPl = mediaText.split(/\r?\n/).map(line => {
      const t = line.trim();
      if (t && !t.startsWith('#')) return `seg${String(localIdx++).padStart(6, '0')}.ts`;
      return line;
    }).join('\n');
    const plPath = path.join(work, 'local.m3u8');
    fs.writeFileSync(plPath, localPl);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmpOut = outFile + '.part.mp4';
    const r = await run(FFMPEG, [
      '-y', '-loglevel', 'error',
      '-allowed_extensions', 'ALL',
      '-i', plPath,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      tmpOut,
    ], { cwd: work });
    if (r.code !== 0 || !fs.existsSync(tmpOut)) {
      throw new Error(`ffmpeg remux failed: ${r.stderr.slice(0, 300)}`);
    }
    fs.renameSync(tmpOut, outFile);
    const bytes = fs.statSync(outFile).size;
    return { ok: true, height, seconds: Math.round(seconds), bytes };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
