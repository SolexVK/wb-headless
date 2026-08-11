// ЮKassa payment provider — fully wired but DISABLED by default.
// Enable later by setting GCUI_YOOKASSA_ENABLED=1 plus shop credentials; no code
// change needed. Until then createPayment() reports that the method is off and
// the UI shows it as "скоро".
//
// Docs: https://yookassa.ru/developers/api
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { cfg } from './config.mjs';

export function isEnabled() { return cfg.yookassa.enabled && cfg.yookassa.shopId && cfg.yookassa.secret; }

// Create a payment and return the confirmation URL to redirect the user to.
export async function createPayment(user) {
  if (!isEnabled()) {
    const e = new Error('Оплата картой (ЮKassa) временно недоступна. Используйте ключ доступа.');
    e.code = 'disabled';
    throw e;
  }
  const auth = Buffer.from(`${cfg.yookassa.shopId}:${cfg.yookassa.secret}`).toString('base64');
  const body = {
    amount: { value: cfg.yookassa.amount, currency: cfg.yookassa.currency },
    capture: true,
    confirmation: { type: 'redirect', return_url: cfg.yookassa.returnUrl || 'https://example.com/paid' },
    description: `Подписка GetCourse Downloader — ${user.username}`,
    metadata: { userId: user.id },
  };
  const res = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Idempotence-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('ЮKassa: ' + (data.description || res.status));
  return { paymentId: data.id, confirmationUrl: data.confirmation?.confirmation_url };
}

// Handle the async webhook (payment.succeeded) and activate the subscription.
export function handleWebhook(payload) {
  if (!isEnabled()) return { ok: false, reason: 'disabled' };
  const event = payload?.event;
  const obj = payload?.object;
  if (event !== 'payment.succeeded' || obj?.status !== 'succeeded') return { ok: false, reason: 'ignored' };
  const userId = obj?.metadata?.userId;
  const u = db.users.find(x => x.id === userId);
  if (!u) return { ok: false, reason: 'user_not_found' };
  const days = cfg.yookassa.days;
  u.subscription = { active: true, expires: new Date(Date.now() + days * 864e5).toISOString() };
  db.save();
  return { ok: true, userId };
}
