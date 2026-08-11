// Google OAuth 2.0 (Authorization Code flow) — no external dependency.
// Enabled only when GCUI_GOOGLE_CLIENT_ID/SECRET are set. Redirect URI must be
// registered in the Google Cloud console as:
//   <public-url>/api/auth/google/callback
import crypto from 'node:crypto';
import { cfg } from './config.mjs';

const pendingStates = new Map(); // state -> expiry (CSRF protection)

export function isEnabled() { return cfg.google.enabled; }

export function redirectUri(baseUrl) {
  const base = (cfg.publicUrl || baseUrl || '').replace(/\/+$/, '');
  return `${base}/api/auth/google/callback`;
}

export function authUrl(baseUrl) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: cfg.google.clientId,
    redirect_uri: redirectUri(baseUrl),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function checkState(state) {
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return exp && exp > Date.now();
}

// Exchange the code for tokens and return the verified {googleId, email}.
export async function exchangeCode(code, baseUrl) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
      redirect_uri: redirectUri(baseUrl),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error('Google: обмен кода не удался');
  // id_token is a JWT: header.payload.signature — read the payload claims.
  const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8'));
  if (!payload.sub) throw new Error('Google: нет идентификатора пользователя');
  return { googleId: payload.sub, email: payload.email, emailVerified: !!payload.email_verified };
}
