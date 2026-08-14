// service/models.js — доступ к данным (users / organizations / memberships /
// cabinets / invitations). Тонкий слой поверх db; при переезде на Postgres
// переписываем только его. WB-токены хранятся в cabinets в шифрованном виде.
import crypto from 'crypto';
import zlib from 'zlib';
import bcrypt from 'bcryptjs';
import { db, tx } from './db.js';
import { config } from './config.js';
import { encryptToken, decryptToken } from './tokens.js';

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, theme, created_at, last_login_at FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  setTheme: db.prepare('UPDATE users SET theme = ? WHERE id = ?'),
  allUsers: db.prepare(`
    SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS memberships,
      (SELECT COUNT(*) FROM organizations o WHERE o.owner_user_id = u.id) AS owns
    FROM users u ORDER BY u.created_at DESC, u.id DESC`),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),

  insertReset: db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)'),
  resetByToken: db.prepare(`SELECT pr.*, u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token = ?`),
  useReset: db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?"),
  pendingResets: db.prepare(`
    SELECT pr.id, pr.token, pr.expires_at, pr.created_at, u.email
    FROM password_resets pr JOIN users u ON u.id = pr.user_id
    WHERE pr.used_at IS NULL AND pr.expires_at > datetime('now') ORDER BY pr.created_at DESC`),

  insertOrg: db.prepare('INSERT INTO organizations (name, owner_user_id, license_seats) VALUES (?, ?, ?)'),
  orgById: db.prepare('SELECT * FROM organizations WHERE id = ?'),
  renameOrg: db.prepare('UPDATE organizations SET name = ? WHERE id = ?'),
  setSeats: db.prepare('UPDATE organizations SET license_seats = ? WHERE id = ?'),
  deleteOrg: db.prepare('DELETE FROM organizations WHERE id = ?'),
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
    FROM organizations o JOIN users u ON u.id = o.owner_user_id ORDER BY o.created_at DESC, o.id DESC`),

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
  allActiveCabinets: db.prepare('SELECT * FROM cabinets WHERE is_active = 1 AND wb_token_enc IS NOT NULL'),
  updateCabinetToken: db.prepare('UPDATE cabinets SET wb_token_enc = ?, token_iv = ?, token_tag = ?, token_meta = ? WHERE id = ?'),
  clearActive: db.prepare('UPDATE cabinets SET is_active = 0 WHERE org_id = ?'),
  setActive: db.prepare('UPDATE cabinets SET is_active = 1 WHERE id = ?'),
  deleteCabinet: db.prepare('DELETE FROM cabinets WHERE id = ?'),

  insertRun: db.prepare(`INSERT INTO report_runs (cabinet_id, report, params_hash, params_json, user_id, summary_json, data_gz, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  latestRun: db.prepare('SELECT * FROM report_runs WHERE cabinet_id = ? AND report = ? ORDER BY created_at DESC, id DESC LIMIT 1'),
  runById: db.prepare('SELECT * FROM report_runs WHERE id = ?'),
  runsByReport: db.prepare(`
    SELECT id, generated_at, created_at, user_id FROM report_runs
    WHERE cabinet_id = ? AND report = ? ORDER BY created_at DESC, id DESC LIMIT 200`),
  runsList: db.prepare(`
    SELECT r.id, r.report, r.params_json, r.summary_json, r.generated_at, r.created_at, r.user_id, u.email AS user_email
    FROM report_runs r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.cabinet_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 200`),
  deleteRunByAuthor: db.prepare('DELETE FROM report_runs WHERE id = ? AND user_id = ?'),
  purgeRuns: db.prepare("DELETE FROM report_runs WHERE created_at < datetime('now', ?)"),

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
  setTheme: (id, theme) => q.setTheme.run(['system', 'light', 'dark'].includes(theme) ? theme : 'system', id),

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

  // Полное удаление пользователя (система «забывает», включая email). Каскадом
  // удаляются его членства и принадлежащие ему компании (кабинеты/снимки/приглашения).
  all: () => q.allUsers.all(),
  remove: (id) => q.deleteUser.run(id).changes > 0,

  setPassword: (id, plain) => q.setPassword.run(bcrypt.hashSync(String(plain), 12), id).changes > 0,
};

const RESET_TTL_MIN = 60;

export const PasswordResets = {
  // Создать одноразовый токен сброса (1 час). Возвращает токен.
  create: (userId) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + RESET_TTL_MIN * 60_000).toISOString();
    q.insertReset.run(userId, token, expires);
    return token;
  },
  byToken: (token) => q.resetByToken.get(token),
  isValid: (r) => r && !r.used_at && new Date(r.expires_at).getTime() > Date.now(),
  use: (id) => q.useReset.run(id),
  pending: () => q.pendingResets.all(),
};

export const Orgs = {
  ofUser: (userId) => q.orgsOfUser.all(userId),
  byId: (id) => q.orgById.get(id),
  rename: (id, name) => q.renameOrg.run(String(name).trim() || 'Компания', id),

  // Может ли пользователь создать компанию. Приглашённый участник (есть членство
  // «member» и нет своей компании) — НЕ может (закрываем лазейку расширения).
  // Разрешено: супер-админу; тем, кто уже владелец; тем, кто ни в одной компании.
  canCreateCompany: (userId, isSuper) => {
    if (isSuper) return true;
    const list = q.orgsOfUser.all(userId);
    const owns = list.some((o) => o.role === 'owner');
    const isMember = list.some((o) => o.role === 'member');
    return owns || !isMember;
  },

  // Создать компанию: организация + membership владельца (лицензия по умолчанию).
  create: (ownerUserId, name) => tx(() => {
    const o = q.insertOrg.run(String(name).trim() || 'Компания', ownerUserId, config.defaultLicenseSeats);
    const orgId = Number(o.lastInsertRowid);
    q.insertMembership.run(ownerUserId, orgId, 'owner');
    return orgId;
  }),

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
  pendingCount: (orgId) => q.pendingCount.get(orgId).n,

  all: () => q.allOrgs.all(),
  remove: (id) => q.deleteOrg.run(id).changes > 0, // отзыв лицензии = удаление компании (каскад)
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
  allActive: () => q.allActiveCabinets.all(), // все активные кабинеты (для автоснимков)

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

const RETENTION_DAYS = 90;
const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
const gunz = (buf) => { try { return JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString('utf8')); } catch { return null; } };

// Архив запусков отчётов компании (сжатый снимок + сводка), общий для участников.
export const ReportRuns = {
  // Сохранить запуск: сжимаем снимок в gzip, кладём сводку для списка. Чистим старьё (90 дн).
  add: ({ cabinetId, report, paramsHash, params, userId, summary, snapshot }) => {
    const id = q.insertRun.run(cabinetId, report, paramsHash, JSON.stringify(params || {}),
      userId || null, JSON.stringify(summary || {}), gz(snapshot), snapshot?.generatedAt || null).lastInsertRowid;
    try { q.purgeRuns.run(`-${RETENTION_DAYS} days`); } catch { /* */ }
    return Number(id);
  },
  // Последний запуск отчёта в компании (для страницы отчёта) — с распакованным снимком.
  latest: (cabinetId, report) => {
    const row = q.latestRun.get(cabinetId, report);
    if (!row) return null;
    return { id: row.id, data: gunz(row.data_gz), createdAt: row.created_at, generatedAt: row.generated_at };
  },
  // Список запусков компании (без тяжёлых снимков) — для каталога/архива.
  list: (cabinetId) => q.runsList.all(cabinetId).map((r) => ({
    id: r.id, report: r.report, userEmail: r.user_email, authorId: r.user_id,
    createdAt: r.created_at, generatedAt: r.generated_at,
    params: safeJson(r.params_json), summary: safeJson(r.summary_json),
  })),
  // Один запуск с распакованным снимком (для просмотра/выгрузки). Проверка компании — снаружи.
  byId: (id) => {
    const row = q.runById.get(id);
    if (!row) return null;
    return { id: row.id, cabinetId: row.cabinet_id, report: row.report, authorId: row.user_id,
      createdAt: row.created_at, generatedAt: row.generated_at,
      params: safeJson(row.params_json), summary: safeJson(row.summary_json), data: gunz(row.data_gz) };
  },
  // Список запусков одного отчёта (лёгкий) — для выбора даты в отчёте.
  datesOf: (cabinetId, report) => q.runsByReport.all(cabinetId, report).map((r) => ({
    id: r.id, createdAt: r.created_at, generatedAt: r.generated_at, authorId: r.user_id,
  })),
  // Удалить может только автор запуска (проверка через user_id в запросе).
  deleteByAuthor: (id, userId) => q.deleteRunByAuthor.run(id, userId).changes > 0,
  purge: () => q.purgeRuns.run(`-${RETENTION_DAYS} days`),
};
const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

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
