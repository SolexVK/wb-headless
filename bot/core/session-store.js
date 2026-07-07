// bot/core/session-store.js — StorageAdapter grammY поверх SQLite (bot_sessions).
// Диалоги переживают рестарт бота.

import { sessionGet, sessionSet, sessionDelete } from '../../lib/db.js';

export function sqliteStorage(db) {
  return {
    read: (key) => sessionGet(db, key),
    write: (key, value) => sessionSet(db, key, value),
    delete: (key) => sessionDelete(db, key),
  };
}
