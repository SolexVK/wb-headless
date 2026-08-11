// Symmetric encryption for data we must keep recoverable (the user's GetCourse
// password, so downloads can run without re-entering it). AES-256-GCM with a key
// that lives only on the server: from GCUI_SECRET, or a random key persisted in
// the data dir (chmod 600). NOT stored in the DB or sent to the browser.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.mjs';

let KEY = null;
function key() {
  if (KEY) return KEY;
  if (process.env.GCUI_SECRET) {
    KEY = crypto.createHash('sha256').update(process.env.GCUI_SECRET).digest();
    return KEY;
  }
  const keyFile = path.join(db.dataDir, 'secret.key');
  try {
    if (fs.existsSync(keyFile)) KEY = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    else {
      KEY = crypto.randomBytes(32);
      fs.mkdirSync(db.dataDir, { recursive: true });
      fs.writeFileSync(keyFile, KEY.toString('hex'), { mode: 0o600 });
    }
  } catch { KEY = crypto.createHash('sha256').update('gc-fallback-key').digest(); }
  return KEY;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(blob) {
  try {
    const [ivh, tagh, ench] = String(blob).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivh, 'hex'));
    d.setAuthTag(Buffer.from(tagh, 'hex'));
    return Buffer.concat([d.update(Buffer.from(ench, 'hex')), d.final()]).toString('utf8');
  } catch { return null; }
}
