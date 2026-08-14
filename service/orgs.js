// service/orgs.js — компании: настройка кабинета WB, участники, приглашения, лицензия.
// Модель доступа: компанию видит только её участник; управлять (кабинет/токен,
// приглашения, участники) может ТОЛЬКО владелец. Число мест (лицензия) ограничивает
// приглашения; менять его может только супер-админ. Приглашённый — участник без
// права приглашать и без доступа к токену. Одна компания = один кабинет.
import express from 'express';
import { Orgs, Members, Cabinets, Invitations } from './models.js';
import { requireAuth } from './security.js';
import { validateToken } from './wb.js';
import { orgPage, inviteAcceptPage, adminPage } from './views.js';
import { logger } from './logger.js';
import { config, isSuperAdmin } from './config.js';

export const orgRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Загрузить компанию и роль текущего пользователя; 404 если не участник.
function loadOrg(req, res, next) {
  const orgId = Number(req.params.id);
  const org = Orgs.byId(orgId);
  const role = org && Orgs.roleOf(req.session.user.id, orgId);
  if (!org || !role) return res.status(404).send('Компания не найдена');
  req.org = org; req.role = role;
  next();
}
// Управлять компанией может только владелец.
const requireOwner = (req, res, next) =>
  Orgs.canManage(req.role) ? next() : res.status(403).send('Только владелец компании может это делать.');
const requireSuperAdmin = (req, res, next) =>
  isSuperAdmin(req.session.user?.email) ? next() : res.status(403).send('Доступно только супер-администратору сервиса.');

// Собрать данные и отрендерить страницу компании (используется и при ошибках форм).
function renderOrg(req, res, extra = {}) {
  const org = Orgs.byId(req.org.id); // свежие данные (имя/лицензия могли измениться)
  const cabinet = Cabinets.firstOf(org.id);
  res.status(extra.status || 200).send(orgPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org, role: req.role,
    members: Members.ofOrg(org.id),
    invites: Orgs.canManage(req.role) ? Invitations.pending(org.id) : [],
    cabinet: cabinet ? { ...cabinet, meta: safeMeta(cabinet.token_meta) } : null,
    seats: { total: Orgs.seats(org), used: Orgs.usedSeats(org.id), canInvite: Orgs.canInviteMore(org) },
    superAdmin: isSuperAdmin(req.session.user.email),
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

// ── Кабинет WB: одноразовая настройка компании и обновление токена ───────────
// Настройка (кабинета ещё нет): имя компании + токен → создаём единственный кабинет.
// Обновление токена (кабинет есть): только новый токен.
orgRouter.post('/org/:id/cabinet', requireAuth, loadOrg, requireOwner, async (req, res) => {
  const existing = Cabinets.firstOf(req.org.id);
  const company = String(req.body.company || '').trim();
  const token = String(req.body.token || '').trim();

  if (!token) return renderOrg(req, res, { status: 400, cabError: 'Вставьте токен WB API.', setupForm: { company } });

  let v;
  try { v = await validateToken(token, { online: config.wbPingOnline }); }
  catch (e) { logger.error(e, 'validateToken'); return renderOrg(req, res, { status: 500, cabError: 'Ошибка проверки токена.', setupForm: { company } }); }

  if (!v.ok) return renderOrg(req, res, { status: 400, cabError: v.errors.join(' '), cabWarn: v.warnings, setupForm: { company } });

  try {
    if (existing) {
      Cabinets.setToken(existing.id, token, v.meta);
      logger.info({ orgId: req.org.id, cabinetId: existing.id, sid: v.meta.sid }, 'токен кабинета обновлён');
    } else {
      if (company) Orgs.rename(req.org.id, company);
      const id = Cabinets.create(req.org.id, company || 'Кабинет WB', token, v.meta);
      logger.info({ orgId: req.org.id, cabinetId: id, sid: v.meta.sid }, 'компания настроена, кабинет создан');
    }
  } catch (e) {
    logger.error(e, 'cabinet save');
    return renderOrg(req, res, { status: 500, cabError: 'Не удалось сохранить кабинет.', setupForm: { company } });
  }
  renderOrg(req, res, { cabOk: (existing ? 'Токен обновлён.' : 'Компания настроена, токен сохранён.') + (v.warnings.length ? ' ' + v.warnings.join(' ') : '') });
});

// ── Приглашения (только владелец, строго в пределах лицензии) ─────────────────
orgRouter.post('/org/:id/invite', requireAuth, loadOrg, requireOwner, (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!EMAIL_RE.test(email)) return renderOrg(req, res, { status: 400, invError: 'Введите корректный email.' });
  if (!Orgs.canInviteMore(req.org)) {
    return renderOrg(req, res, { status: 403, invError: `Лимит мест по лицензии исчерпан (${Orgs.seats(req.org)}). Расширить может только администратор сервиса.` });
  }
  const token = Invitations.create(req.org.id, email, 'member'); // приглашённые всегда участники
  logger.info({ orgId: req.org.id, email }, 'приглашение создано');
  const link = `${req.protocol}://${req.get('host')}${res.locals.base || ''}/invite/${token}`;
  req.session.flash = { orgId: req.org.id, data: { inviteCreated: { email, url: link } } };
  res.redirect(`/org/${req.org.id}`);
});

orgRouter.post('/org/:id/invite/:inviteId/revoke', requireAuth, loadOrg, requireOwner, (req, res) => {
  Invitations.revoke(req.org.id, Number(req.params.inviteId));
  renderOrg(req, res, { invOk: 'Приглашение отозвано.' });
});

orgRouter.post('/org/:id/member/:userId/remove', requireAuth, loadOrg, requireOwner, (req, res) => {
  Members.remove(req.org.id, Number(req.params.userId)); // владельца убрать нельзя (защита в SQL)
  renderOrg(req, res, { memOk: 'Участник удалён.' });
});

// ── Супер-админ: лицензии (число мест компаний) ─────────────────────────────
orgRouter.get('/admin', requireAuth, requireSuperAdmin, (req, res) => {
  res.send(adminPage({ user: req.session.user, csrf: res.locals.csrf, base: res.locals.base, orgs: Orgs.all(), ok: req.query.ok }));
});
orgRouter.post('/admin/org/:id/seats', requireAuth, requireSuperAdmin, (req, res) => {
  const seats = Math.max(1, Math.round(Number(req.body.seats) || 1));
  Orgs.setSeats(Number(req.params.id), seats);
  logger.info({ orgId: Number(req.params.id), seats, by: req.session.user.email }, 'супер-админ: изменил число мест');
  res.redirect('/admin?ok=1');
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
  // Лицензия: не превышаем число мест (на случай, если лимит уменьшили после выдачи).
  const org = Orgs.byId(invite.org_id);
  if (!Orgs.isMember(req.session.user.id, invite.org_id) && Orgs.membersCount(invite.org_id) >= Orgs.seats(org)) {
    return res.status(403).send(inviteAcceptPage({ csrf: res.locals.csrf, user: req.session.user, org, invite, token: req.params.token, full: true, base: res.locals.base }));
  }
  Invitations.accept(invite, req.session.user.id);
  logger.info({ orgId: invite.org_id, userId: req.session.user.id }, 'приглашение принято');
  res.redirect(`/org/${invite.org_id}`);
});
