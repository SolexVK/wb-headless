// Safe server-side directory browser for the "choose download folder" UI.
// Access is confined to a configurable root (GCUI_BROWSE_ROOT, default: the
// user's home directory) so the web app can never read outside it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ROOT = path.resolve(process.env.GCUI_BROWSE_ROOT || os.homedir());

// Resolve a requested path and ensure it stays within ROOT.
export function resolveInsideRoot(p) {
  const abs = path.resolve(ROOT, p || '.');
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // escaped root
  return abs;
}

export function listDir(p) {
  const abs = resolveInsideRoot(p);
  if (!abs) throw new Error('путь вне разрешённой области');
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, path: path.relative(ROOT, path.join(abs, e.name)) || e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    root: ROOT,
    path: path.relative(ROOT, abs),
    absolute: abs,
    parent: abs === ROOT ? null : path.relative(ROOT, path.dirname(abs)),
    dirs: entries,
  };
}

export function createDir(p, name) {
  const abs = resolveInsideRoot(p);
  if (!abs) throw new Error('путь вне разрешённой области');
  const safeName = String(name || '').replace(/[\/\\:*?"<>|]+/g, '-').trim();
  if (!safeName) throw new Error('пустое имя папки');
  const target = path.join(abs, safeName);
  if (resolveInsideRoot(path.relative(ROOT, target)) === null) throw new Error('недопустимый путь');
  fs.mkdirSync(target, { recursive: true });
  return { path: path.relative(ROOT, target), absolute: target };
}

// Validate that a chosen output dir is inside ROOT and writable; return abs path.
export function resolveWritableOutput(p) {
  const abs = resolveInsideRoot(p);
  if (!abs) throw new Error('папка вне разрешённой области');
  fs.mkdirSync(abs, { recursive: true });
  fs.accessSync(abs, fs.constants.W_OK);
  return abs;
}
