// Per-user stored GetCourse credentials. Email is kept in clear (shown back to
// the user), the password is AES-GCM encrypted at rest and never sent to the
// browser. Used so repeat downloads don't require re-entering the password.
import { db } from './db.mjs';
import { encrypt, decrypt } from './crypto.mjs';

export function saveCreds(user, { email, password, remember }) {
  user.gc = user.gc || {};
  if (email !== undefined) user.gc.email = String(email || '').trim();
  if (remember === false) { user.gc.enc = null; }
  else if (password) { user.gc.enc = encrypt(password); }
  db.save();
}

export function credsView(user) {
  const gc = user.gc || {};
  return { email: gc.email || '', hasPassword: !!gc.enc };
}

export function getEmail(user) { return (user.gc && user.gc.email) || ''; }
export function getPassword(user) { return user.gc && user.gc.enc ? decrypt(user.gc.enc) : null; }
