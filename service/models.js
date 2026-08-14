// service/models.js — доступ к данным (users / organizations / memberships).
// Тонкий слой поверх db; при переезде на Postgres переписываем только его.
import bcrypt from 'bcryptjs';
import { db, tx } from './db.js';

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, created_at, last_login_at FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  insertOrg: db.prepare('INSERT INTO organizations (name, owner_user_id) VALUES (?, ?)'),
  insertMembership: db.prepare('INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)'),
  orgsOfUser: db.prepare(`
    SELECT o.id, o.name, m.role
    FROM memberships m JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ? ORDER BY o.created_at`),
};

export const Users = {
  byEmail: (email) => q.userByEmail.get(String(email).trim()),
  byId: (id) => q.userById.get(id),
  touchLogin: (id) => q.touchLogin.run(id),

  // Регистрация: пользователь + личная организация + membership owner (в транзакции).
  register: (email, password, name) => tx(() => {
    const hash = bcrypt.hashSync(password, 12);
    const u = q.insertUser.run(String(email).trim(), hash, name || null);
    const userId = Number(u.lastInsertRowid);
    const orgName = (name && name.trim()) ? `${name.trim()} — организация` : `${String(email).split('@')[0]} — организация`;
    const o = q.insertOrg.run(orgName, userId);
    q.insertMembership.run(userId, Number(o.lastInsertRowid), 'owner');
    return userId;
  }),

  verify: (user, password) => bcrypt.compareSync(password, user.password_hash),
};

export const Orgs = {
  ofUser: (userId) => q.orgsOfUser.all(userId),
};
