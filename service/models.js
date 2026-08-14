// service/models.js — доступ к данным (users / organizations / memberships /
// cabinets / invitations). Тонкий слой поверх db; при переезде на Postgres
// переписываем только его. WB-токены хранятся в cabinets в шифрованном виде.
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db, tx } from './db.js';
import { config } from './config.js';
import { encryptToken, decryptToken } from './tokens.js';

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, created_at, last_login_at FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),

  insertOrg: db.prepare('INSERT INTO organizations (name, owner_user_id, license_seats) VALUES (?, ?, ?)'),
  orgById: db.prepare('SELECT * FROM organizations WHERE id = ?'),
  renameOrg: db.prepare('UPDATE organizations SET name = ? WHERE id = ?'),
  setSeats: db.prepare('UPDATE organizations SET license_seats = ? WHERE id = ?'),
  orgsOfUser: db.prepare(`
    SELECT o.id, o.name, o.license_seats, m.role
    FROM memberships m JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ? ORDER BY o.created_at`),
  membersCount: db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?'),
  pendingCount: db.prepare("SELECT COUNT(*) AS n FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')"),
  allOrgs: db.prepare(`
    SELECT o.id, o.name, o.license_seats, o.created_at, u.email AS owner_email,
      (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members,
      (SELECT COUNT(*) FROM invitations i WHERE i.org_id = o.id AND i.accepted_at IS NULL AND i.expires_at > datetime('now')) AS pending
    FROM organizations o JOIN users u ON u.id = o.owner_user_id ORDER BY o.created_at DESC`),

  insertMembership: db.prepare('INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)'),
  membership: db.prepare('SELECT * FROM memberships WHERE user_id = ? AND org_id = ?'),
  membersOfOrg: db.prepare(`
    SELECT m.id, m.role, m.created_at, u.id AS user_id, u.email, u.name
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`),
  updateRole: db.prepare("UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ? AND role <> 'owner'"),
  deleteMembership: db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ? AND role <> 'owner'"),

  insertCabinet: db.prepare(`INSERT INTO cabinets (org_id, name, wb_token_enc, token_iv, token_tag, token_meta, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  cabinetsOfOrg: db.prepare('SELECT id, org_id, name, token_meta, is_active, created_at, (wb_token_enc IS NOT NULL) AS has_token FROM cabinets WHERE org_id = ? ORDER BY created_at'),
  cabinetById: db.prepare('SELECT * FROM cabinets WHERE id = ?'),
  firstCabinet: db.prepare('SELECT * FROM cabinets WHERE org_id = ? ORDER BY created_at LIMIT 1'),
  activeCabinet: db.prepare('SELECT * FROM cabinets WHERE org_id = ? AND is_active = 1 AND wb_token_enc IS NOT NULL ORDER BY created_at LIMIT 1'),
  updateCabinetToken: db.prepare('UPDATE cabinets SET wb_token_enc = ?, token_iv = ?, token_tag = ?, token_meta = ? WHERE id = ?'),
  clearActive: db.prepare('UPDATE cabinets SET is_active = 0 WHERE org_id = ?'),
  setActive: db.prepare('UPDATE cabinets SET is_active = 1 WHERE id = ?'),
  deleteCabinet: db.prepare('DELETE FROM cabinets WHERE id = ?'),

  putSnap: db.prepare(`INSERT INTO snapshot_cache (cabinet_id, report, params_hash, json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cabinet_id, report, params_hash) DO UPDATE SET json = excluded.json, refreshed_at = datetime('now')`),
  latestSnap: db.prepare(`SELECT json, params_hash, refreshed_at FROM snapshot_cache
    WHERE cabinet_id = ? AND report = ? ORDER BY refreshed_at DESC LIMIT 1`),

  insertInvite: db.prepare('INSERT INTO invitations (org_id, email, role, token, expires_at) VALUES (?, ?, ?, ?, ?)'),
  inviteByToken: db.prepare('SELECT * FROM invitations WHERE token = ?'),
  pendingInvites: db.prepare("SELECT id, email, role, token, expires_at, created_at FROM invitations WHERE org_id = ? AND accepted_at IS NULL ORDER BY created_at DESC"),
  acceptInvite: db.prepare("UPDATE invitations SET accepted_at = datetime('now') WHERE id = ?"),
  deleteInvite: db.prepare('DELETE FROM invitations WHERE id = ? AND org_id = ?'),
};

const ROLE_RANK = { owner: 3, admin: 2, member: 1 };

export const Users = {
  byEmail: (email) => q.userByEmail.get(String(email).trim()),
  byId: (id) => q.userById.get(id),
  touchLogin: (id) => q.touchLogin.run(id),

  // Регистрация. По умолчанию создаётся личная компания (владелец, лицензия по
  // умолчанию). При регистрации по приглашению (createOrg=false) компания НЕ
  // создаётся — человек станет участником приглашающей компании (закрываем
  // «лазейку» бесконечных приглашений).
  register: (email, password, name, { createOrg = true } = {}) => tx(() => {
    const hash = bcrypt.hashSync(password, 12);
    const u = q.insertUser.run(String(email).trim(), hash, name || null);
    const userId = Number(u.lastInsertRowid);
    if (createOrg) {
      const orgName = (name && name.trim()) ? `${name.trim()} — компания` : `${String(email).split('@')[0]} — компания`;
      const o = q.insertOrg.run(orgName, userId, config.defaultLicenseSeats);
      q.insertMembership.run(userId, Number(o.lastInsertRowid), 'owner');
    }
    return userId;
  }),

  verify: (user, password) => bcrypt.compareSync(password, user.password_hash),
};

export const Orgs = {
  ofUser: (userId) => q.orgsOfUser.all(userId),
  byId: (id) => q.orgById.get(id),
  rename: (id, name) => q.renameOrg.run(String(name).trim() || 'Компания', id),

  // Роль пользователя в организации или null, если не участник.
  roleOf: (userId, orgId) => q.membership.get(userId, orgId)?.role || null,
  isMember: (userId, orgId) => !!q.membership.get(userId, orgId),
  // Управлять компанией (кабинет/токен/участники/приглашения) может только владелец.
  canManage: (role) => role === 'owner',

  // Лицензия/места.
  seats: (org) => Number(org?.license_seats || 1),
  setSeats: (id, n) => q.setSeats.run(Math.max(1, Math.round(Number(n) || 1)), id),
  usedSeats: (orgId) => q.membersCount.get(orgId).n + q.pendingCount.get(orgId).n, // участники + непринятые приглашения
  canInviteMore: (org) => (q.membersCount.get(org.id).n + q.pendingCount.get(org.id).n) < Number(org.license_seats || 1),
  membersCount: (orgId) => q.membersCount.get(orgId).n,

  all: () => q.allOrgs.all(),
};

export const Members = {
  ofOrg: (orgId) => q.membersOfOrg.all(orgId),
  // Смена роли (нельзя менять owner). Возвращает true, если строка затронута.
  setRole: (orgId, userId, role) => {
    if (!['admin', 'member'].includes(role)) throw new Error('bad role');
    return q.updateRole.run(role, orgId, userId).changes > 0;
  },
  remove: (orgId, userId) => q.deleteMembership.run(orgId, userId).changes > 0,
  add: (userId, orgId, role) => q.insertMembership.run(userId, orgId, role),
  rank: (role) => ROLE_RANK[role] || 0,
};

export const Cabinets = {
  ofOrg: (orgId) => q.cabinetsOfOrg.all(orgId),
  byId: (id) => q.cabinetById.get(id),
  activeOf: (orgId) => q.activeCabinet.get(orgId),
  firstOf: (orgId) => q.firstCabinet.get(orgId), // одна компания = один кабинет

  // Создать кабинет и (опц.) сразу привязать зашифрованный токен.
  create: (orgId, name, token, meta) => tx(() => {
    let enc = null, iv = null, tag = null, metaJson = null;
    if (token) {
      const e = encryptToken(token);
      enc = e.enc; iv = e.iv; tag = e.tag;
      metaJson = JSON.stringify(meta || {});
    }
    const existing = q.cabinetsOfOrg.all(orgId).length;
    const isActive = existing === 0 ? 1 : 0; // первый кабинет — активный
    const r = q.insertCabinet.run(orgId, name, enc, iv, tag, metaJson, isActive);
    return Number(r.lastInsertRowid);
  }),

  // Перепривязать/обновить токен.
  setToken: (cabinetId, token, meta) => {
    const e = encryptToken(token);
    return q.updateCabinetToken.run(e.enc, e.iv, e.tag, JSON.stringify(meta || {}), cabinetId).changes > 0;
  },

  // Достать расшифрованный токен (для запуска отчётов). Возвращает null, если не привязан.
  decryptedToken: (cabinet) => {
    if (!cabinet?.wb_token_enc) return null;
    return decryptToken({ enc: cabinet.wb_token_enc, iv: cabinet.token_iv, tag: cabinet.token_tag });
  },

  meta: (cabinet) => { try { return JSON.parse(cabinet?.token_meta || '{}'); } catch { return {}; } },

  setActive: (orgId, cabinetId) => tx(() => {
    q.clearActive.run(orgId);
    q.setActive.run(cabinetId);
  }),

  remove: (id) => q.deleteCabinet.run(id).changes > 0,
};

export const Snapshots = {
  put: (cabinetId, report, paramsHash, obj) => q.putSnap.run(cabinetId, report, paramsHash, JSON.stringify(obj)),
  latest: (cabinetId, report) => {
    const row = q.latestSnap.get(cabinetId, report);
    if (!row) return null;
    try { return { data: JSON.parse(row.json), paramsHash: row.params_hash, refreshedAt: row.refreshed_at }; }
    catch { return null; }
  },
};

const INVITE_TTL_DAYS = 7;

export const Invitations = {
  create: (orgId, email, role) => {
    if (!['admin', 'member'].includes(role)) throw new Error('bad role');
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();
    q.insertInvite.run(orgId, String(email).trim(), role, token, expires);
    return token;
  },
  byToken: (token) => q.inviteByToken.get(token),
  pending: (orgId) => q.pendingInvites.all(orgId),
  revoke: (orgId, id) => q.deleteInvite.run(id, orgId).changes > 0,

  // Принять приглашение вошедшим пользователем: создаёт membership и помечает принятым.
  accept: (invite, userId) => tx(() => {
    if (!q.membership.get(userId, invite.org_id)) {
      q.insertMembership.run(userId, invite.org_id, invite.role);
    }
    q.acceptInvite.run(invite.id);
  }),

  isValid: (invite) => invite && !invite.accepted_at && new Date(invite.expires_at).getTime() > Date.now(),
};
