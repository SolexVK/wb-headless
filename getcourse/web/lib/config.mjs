// Central place for environment-driven settings (limits, storage, billing).
import './loadenv.mjs'; // MUST be first: populate process.env from .env before we read it
import path from 'node:path';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const cfg = {
  port: num(process.env.GCUI_PORT, 7837),
  host: process.env.GCUI_HOST || '127.0.0.1',

  // Temporary storage for "delivery" users (non-local). Each user gets a
  // per-user subfolder; files are handed to the browser and then swept.
  spoolRoot: path.resolve(process.env.GCUI_SPOOL_ROOT || path.join(process.cwd(), 'web', 'spool')),

  // Retention: delete a delivered file this many minutes after it finished
  // downloading to the spool (user is warned in the UI).
  retentionMin: num(process.env.GCUI_RETENTION_MIN, 30),

  // Daily quota per delivery user.
  dailyGB: num(process.env.GCUI_DAILY_GB, 200),        // total volume produced per day
  dailyFiles: num(process.env.GCUI_DAILY_FILES, 0),    // 0 = unlimited count
  // Max spool footprint per user at any moment (disk safety); 0 = same as dailyGB.
  userQuotaGB: num(process.env.GCUI_USER_QUOTA_GB, 200),

  // Public URL (for OAuth redirects / reset links). Falls back to the request
  // origin when empty.
  publicUrl: (process.env.GCUI_PUBLIC_URL || '').replace(/\/+$/, ''),

  // Registration
  allowSignup: process.env.GCUI_ALLOW_SIGNUP === undefined ? true : process.env.GCUI_ALLOW_SIGNUP !== '0',
  // Auto-grant a license on signup (until real payment is wired). Set 0 to
  // require payment/keys instead.
  signupLicenseDays: num(process.env.GCUI_SIGNUP_LICENSE_DAYS, 30),

  // Google OAuth (optional). Set both to enable "Sign in with Google".
  google: {
    clientId: process.env.GCUI_GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GCUI_GOOGLE_CLIENT_SECRET || '',
    get enabled() { return !!(this.clientId && this.clientSecret); },
  },

  // SMTP for password-reset emails (optional). Without it, reset links are
  // surfaced to the admin panel for manual delivery.
  smtp: {
    host: process.env.GCUI_SMTP_HOST || '',
    port: num(process.env.GCUI_SMTP_PORT, 587),
    user: process.env.GCUI_SMTP_USER || '',
    pass: process.env.GCUI_SMTP_PASS || '',
    from: process.env.GCUI_SMTP_FROM || '',
    get enabled() { return !!(this.host && this.user); },
  },

  // Billing
  licenseKeys: (process.env.GCUI_LICENSE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean),
  licenseDays: num(process.env.GCUI_LICENSE_DAYS, 30),
  priceNote: process.env.GCUI_PRICE_NOTE || 'Доступ по подписке.',

  // ЮKassa (stubbed until enabled). When GCUI_YOOKASSA_ENABLED is set, the
  // real payment flow in billing_yookassa.mjs activates.
  yookassa: {
    enabled: !!process.env.GCUI_YOOKASSA_ENABLED,
    shopId: process.env.GCUI_YOOKASSA_SHOP_ID || '',
    secret: process.env.GCUI_YOOKASSA_SECRET || '',
    amount: process.env.GCUI_YOOKASSA_AMOUNT || '990.00',
    currency: process.env.GCUI_YOOKASSA_CURRENCY || 'RUB',
    days: num(process.env.GCUI_YOOKASSA_DAYS, 30),
    returnUrl: process.env.GCUI_YOOKASSA_RETURN_URL || '',
  },
};

export const bytesPerGB = 1024 * 1024 * 1024;
