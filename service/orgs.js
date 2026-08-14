// service/orgs.js — организации: участники, роли, приглашения, кабинеты WB.
// Доступ: видеть организацию может только её участник; управлять (кабинеты,
// приглашения, роли) — owner/admin. WB-токен проверяется (validateToken) перед
// привязкой и хранится только в шифрованном виде.
import express from 'express';
import { Orgs, Members, Cabinets, Invitations } from './models.js';
import { requireAuth } from './security.js';
import { validateToken } from './wb.js';
import { orgPage, inviteAcceptPage } from './views.js';
import { logger } from './logger.js';
import { config } from './config.js';

export const orgRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Загрузить организацию и роль текущего пользователя; 404 если не участник.
function loadOrg(req, res, next) {
  const orgId = Number(req.params.id);
  const org = Orgs.byId(orgId);
  const role = org && Orgs.roleOf(req.session.user.id, orgId);
  if (!org || !role) return res.status(404).send('Организация не найдена');
  req.org = org; req.role = role;
  next();
}
const requireManage = (req, res, next) =>
  Orgs.canManage(req.role) ? next() : res.status(403).send('Недостаточно прав (нужна роль owner или admin).');

// Собрать данные и отрендерить страницу организации (используется и при ошибках форм).
function renderOrg(req, res, extra = {}) {
  const cabinets = Cabinets.ofOrg(req.org.id).map((c) => ({ ...c, meta: safeMeta(c.token_meta) }));
  res.status(extra.status || 200).send(orgPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role,
    members: Members.ofOrg(req.org.id),
    invites: Orgs.canManage(req.role) ? Invitations.pending(req.org.id) : [],
    cabinets,
    ...extra,
  }));
}
const safeMeta = (j) => { try { return JSON.parse(j || '{}'); } catch { return {}; } };

// ── Страница организации ─────────────────────────────────────────────────────
orgRouter.get('/org/:id', requireAuth, loadOrg, (req, res) => {
  // Flash после POST-Redirect-GET (напр. созданная ссылка-приглашение) — чистый URL.
  const flash = req.session.flash; req.session.flash = undefined;
  renderOrg(req, res, flash && flash.orgId === req.org.id ? flash.data : {});
});

// ── Кабинеты: привязка/обновление токена WB ─────────────────────────────────
orgRouter.post('/org/:id/cabinet', requireAuth, loadOrg, requireManage, async (req, res) => {
  const name = String(req.body.name || '').trim() || 'Кабинет WB';
  const token = String(req.body.token || '').trim();
  const cabinetId = req.body.cabinet_id ? Number(req.body.cabinet_id) : null;

  if (!token) return renderOrg(req, res, { status: 400, cabError: 'Вставьте токен WB API.', cabForm: { name, cabinetId } });

  let v;
  try { v = await validateToken(token, { online: config.wbPingOnline }); }
  catch (e) { logger.error(e, 'validateToken'); return renderOrg(req, res, { status: 500, cabError: 'Ошибка проверки токена.', cabForm: { name, cabinetId } }); }

  if (!v.ok) {
    return renderOrg(req, res, { status: 400, cabError: v.errors.join(' '), cabWarn: v.warnings, cabForm: { name, cabinetId } });
  }

  try {
    if (cabinetId) {
      const cab = Cabinets.byId(cabinetId);
      if (!cab || cab.org_id !== req.org.id) return res.status(404).send('Кабинет не найден');
      Cabinets.setToken(cabinetId, token, v.meta);
      logger.info({ orgId: req.org.id, cabinetId, sid: v.meta.sid }, 'токен кабинета обновлён');
    } else {
      const id = Cabinets.create(req.org.id, name, token, v.meta);
      logger.info({ orgId: req.org.id, cabinetId: id, sid: v.meta.sid }, 'кабинет создан + токен привязан');
    }
  } catch (e) {
    logger.error(e, 'cabinet save');
    return renderOrg(req, res, { status: 500, cabError: 'Не удалось сохранить кабинет.', cabForm: { name, cabinetId } });
  }
  renderOrg(req, res, { cabOk: 'Токен проверен и сохранён.' + (v.warnings.length ? ' ' + v.warnings.join(' ') : '') });
});

orgRouter.post('/org/:id/cabinet/:cid/activate', requireAuth, loadOrg, requireManage, (req, res) => {
  const cab = Cabinets.byId(Number(req.params.cid));
  if (!cab || cab.org_id !== req.org.id) return res.status(404).send('Кабинет не найден');
  Cabinets.setActive(req.org.id, cab.id);
  renderOrg(req, res, { cabOk: `Активный кабинет: ${cab.name}.` });
});

orgRouter.post('/org/:id/cabinet/:cid/remove', requireAuth, loadOrg, requireManage, (req, res) => {
  const cab = Cabinets.byId(Number(req.params.cid));
  if (!cab || cab.org_id !== req.org.id) return res.status(404).send('Кабинет не найден');
  Cabinets.remove(cab.id);
  logger.info({ orgId: req.org.id, cabinetId: cab.id }, 'кабинет удалён');
  renderOrg(req, res, { cabOk: `Кабинет «${cab.name}» удалён.` });
});

// ── Приглашения ──────────────────────────────────────────────────────────────
orgRouter.post('/org/:id/invite', requireAuth, loadOrg, requireManage, (req, res) => {
  const email = String(req.body.email || '').trim();
  const role = String(req.body.role || 'member');
  if (!EMAIL_RE.test(email)) return renderOrg(req, res, { status: 400, invError: 'Введите корректный email.' });
  if (!['admin', 'member'].includes(role)) return renderOrg(req, res, { status: 400, invError: 'Некорректная роль.' });
  const token = Invitations.create(req.org.id, email, role);
  logger.info({ orgId: req.org.id, email, role }, 'приглашение создано');
  const link = `${req.protocol}://${req.get('host')}${res.locals.base || ''}/invite/${token}`;
  // PRG: кладём результат во flash и редиректим на чистый URL организации,
  // чтобы ссылка отображалась кликабельной, а адресная строка не путала.
  req.session.flash = { orgId: req.org.id, data: { inviteCreated: { email, url: link } } };
  res.redirect(`/org/${req.org.id}`);
});

orgRouter.post('/org/:id/invite/:inviteId/revoke', requireAuth, loadOrg, requireManage, (req, res) => {
  Invitations.revoke(req.org.id, Number(req.params.inviteId));
  renderOrg(req, res, { invOk: 'Приглашение отозвано.' });
});

// ── Роли и удаление участников ──────────────────────────────────────────────
orgRouter.post('/org/:id/member/:userId/role', requireAuth, loadOrg, requireManage, (req, res) => {
  const role = String(req.body.role || '');
  if (!['admin', 'member'].includes(role)) return renderOrg(req, res, { status: 400, memError: 'Некорректная роль.' });
  Members.setRole(req.org.id, Number(req.params.userId), role);
  renderOrg(req, res, { memOk: 'Роль обновлена.' });
});

orgRouter.post('/org/:id/member/:userId/remove', requireAuth, loadOrg, requireManage, (req, res) => {
  Members.remove(req.org.id, Number(req.params.userId));
  renderOrg(req, res, { memOk: 'Участник удалён.' });
});

// ── Приём приглашения ────────────────────────────────────────────────────────
orgRouter.get('/invite/:token', (req, res) => {
  const invite = Invitations.byToken(req.params.token);
  // req.url — путь без префикса base (его срезает mount); redirect-обёртка вернёт base сама.
  if (!req.session.user) {
    req.session.returnTo = req.url;
    // Подсказка для формы регистрации/входа: по какому email и в какую орг зовут.
    if (Invitations.isValid(invite)) {
      const o = Orgs.byId(invite.org_id);
      req.session.inviteHint = { email: invite.email, orgName: o?.name || '' };
    }
    return res.redirect('/register'); // приглашённые обычно новые; на странице есть ссылка «Войти»
  }
  if (!Invitations.isValid(invite)) return res.status(410).send(inviteAcceptPage({ csrf: res.locals.csrf, user: req.session.user, invalid: true, base: res.locals.base }));
  const org = Orgs.byId(invite.org_id);
  const already = Orgs.isMember(req.session.user.id, invite.org_id);
  const mismatch = String(req.session.user.email).toLowerCase() !== String(invite.email).toLowerCase();
  res.send(inviteAcceptPage({ csrf: res.locals.csrf, user: req.session.user, org, invite, already, mismatch, token: req.params.token, base: res.locals.base }));
});

orgRouter.post('/invite/:token/accept', requireAuth, (req, res) => {
  const invite = Invitations.byToken(req.params.token);
  if (!Invitations.isValid(invite)) return res.status(410).send(inviteAcceptPage({ csrf: res.locals.csrf, user: req.session.user, invalid: true, base: res.locals.base }));
  // Строгая привязка: принять может только тот, на чей email выписано приглашение.
  if (String(req.session.user.email).toLowerCase() !== String(invite.email).toLowerCase()) {
    const org = Orgs.byId(invite.org_id);
    return res.status(403).send(inviteAcceptPage({ csrf: res.locals.csrf, user: req.session.user, org, invite, token: req.params.token, mismatch: true, base: res.locals.base }));
  }
  Invitations.accept(invite, req.session.user.id);
  logger.info({ orgId: invite.org_id, userId: req.session.user.id }, 'приглашение принято');
  res.redirect(`/org/${invite.org_id}`);
});
