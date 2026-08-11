// Per-user daily download quotas (volume + optional file count) for delivery
// users. Usage is stored on the user record keyed by calendar day.
import { db } from './db.mjs';
import { cfg, bytesPerGB } from './config.mjs';

function today() { return new Date().toISOString().slice(0, 10); }

export function getUsage(user) {
  const day = today();
  const u = db.users.find(x => x.id === user.id);
  if (!u) return { bytes: 0, files: 0 };
  if (!u.usage || u.usage.day !== day) u.usage = { day, bytes: 0, files: 0 };
  return u.usage;
}

export function limits() {
  return {
    dailyBytes: cfg.dailyGB * bytesPerGB,
    dailyFiles: cfg.dailyFiles, // 0 = unlimited
  };
}

// Would producing `addBytes` exceed today's quota? Returns null if OK, else a
// human message.
export function quotaBlock(user, addBytes = 0) {
  if (user.role === 'admin') return null;
  const usage = getUsage(user);
  const lim = limits();
  if (usage.bytes + addBytes > lim.dailyBytes) {
    return `Дневной лимит объёма исчерпан (${cfg.dailyGB} ГБ/день).`;
  }
  if (lim.dailyFiles && usage.files + 1 > lim.dailyFiles) {
    return `Дневной лимит по количеству файлов исчерпан (${lim.dailyFiles}).`;
  }
  return null;
}

export function addUsage(user, bytes) {
  const usage = getUsage(user);
  usage.bytes += bytes;
  usage.files += 1;
  db.save();
}

export function usageView(user) {
  const usage = getUsage(user);
  const lim = limits();
  return {
    day: usage.day,
    bytes: usage.bytes,
    files: usage.files,
    dailyGB: cfg.dailyGB,
    dailyBytes: lim.dailyBytes,
    dailyFiles: lim.dailyFiles,
    retentionMin: cfg.retentionMin,
    unlimited: user.role === 'admin',
  };
}
