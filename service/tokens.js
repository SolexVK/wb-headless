// service/tokens.js — шифрование WB-токенов (AES-256-GCM). Готово к Фазе 1.
// Ключ — config.tokenEncKey (32 байта hex). Токены НИКОГДА не хранятся в открытом
// виде и не логируются. Здесь только encrypt/decrypt; wiring кабинетов — Фаза 1.
import crypto from 'crypto';
import { config } from './config.js';

function key() {
  if (!config.tokenEncKey) throw new Error('TOKEN_ENC_KEY не задан (нужен для шифрования WB-токенов)');
  const k = Buffer.from(config.tokenEncKey, 'hex');
  if (k.length !== 32) throw new Error('TOKEN_ENC_KEY должен быть 32 байта в hex (64 символа)');
  return k;
}

export function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { enc: enc.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function decryptToken({ enc, iv, tag }) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
