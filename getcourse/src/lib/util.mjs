// Shared helpers: logging, filename sanitizing, small utils.
import { spawn } from 'node:child_process';

export function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
export function warn(...a) { console.warn(new Date().toISOString().slice(11, 19), 'WARN', ...a); }

// Make a string safe to use as a file/dir name across macOS/Linux.
export function sanitize(name, maxLen = 120) {
  let s = (name || '').replace(/\s+/g, ' ').trim();
  // strip UI noise that GetCourse appends to lesson titles
  s = s.replace(/\s*просмотрено\s*/gi, ' ');
  s = s.replace(/[\/\\:*?"<>|]+/g, '-'); // replace illegal path chars with a dash
  s = s.replace(/\s+/g, ' ').trim();      // collapse whitespace
  s = s.replace(/\.+$/, '').trim();       // no trailing dots (Windows/macOS)
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || 'untitled';
}

export function pad(n, width = 2) { return String(n).padStart(width, '0'); }

// Run a command, resolve with {code, stdout, stderr}. Never rejects on non-zero.
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts });
    let out = '', err = '';
    if (p.stdout) p.stdout.on('data', d => { out += d; });
    if (p.stderr) p.stderr.on('data', d => { err += d; });
    p.on('error', e => resolve({ code: -1, stdout: out, stderr: String(e) }));
    p.on('close', code => resolve({ code, stdout: out, stderr: err }));
  });
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Simple concurrency pool: run tasks N at a time, preserving result order.
export async function pool(items, worker, concurrency = 10) {
  const results = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}
