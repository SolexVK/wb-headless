// service/auth.js — маршруты регистрации / входа / выхода.
import express from 'express';
import { Users, Orgs, PasswordResets } from './models.js';
import { authLimiter, requireAuth } from './security.js';
import { loginPage, registerPage, homePage, forgotPage, forgotSentPage, resetPage } from './views.js';
import { logger } from './logger.js';
import { isSuperAdmin } from './config.js';

export const authRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const setSession = (req, u) => { req.session.user = { id: u.id, email: u.email, name: u.name }; req.session.inviteHint = undefined; };
// Подсказка при заходе по ссылке-приглашению (email + название организации).
const inviteNotice = (req) => {
  const h = req.session.inviteHint;
  if (!h) return {};
  return { email: h.email, notice: `Вас пригласили в организацию «${h.orgName}». Зарегистрируйтесь или войдите — затем подтвердите вступление.` };
};
// Куда вернуть после входа: сохранённый returnTo (напр. ссылка-приглашение), иначе '/'.
// Разрешаем только локальные пути (без //) — защита от open redirect.
const popReturnTo = (req) => {
  const to = req.session.returnTo;
  req.session.returnTo = undefined;
  return (typeof to === 'string' && to.startsWith('/') && !to.startsWith('//')) ? to : '/';
};

// ── Регистрация ─────────────────────────────────────────────────────────────
authRouter.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(registerPage({ csrf: res.locals.csrf, base: res.locals.base, ...inviteNotice(req) }));
});

authRouter.post('/register', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  const fail = (error) => res.status(400).send(registerPage({ csrf: res.locals.csrf, error, email, name, base: res.locals.base }));

  if (!EMAIL_RE.test(email)) return fail('Введите корректный email.');
  if (password.length < 8) return fail('Пароль должен быть не короче 8 символов.');
  if (Users.byEmail(email)) return fail('Аккаунт с таким email уже существует.');

  try {
    // Регистрация по приглашению (email совпал с приглашением) НЕ создаёт свою
    // компанию — человек станет участником приглашающей. Иначе создаём компанию.
    const h = req.session.inviteHint;
    const viaInvite = h && String(h.email).toLowerCase() === email.toLowerCase();
    const userId = Users.register(email, password, name, { createOrg: !viaInvite });
    const u = Users.byId(userId);
    setSession(req, u);
    logger.info({ userId, viaInvite: !!viaInvite }, 'зарегистрирован пользователь');
    res.redirect(popReturnTo(req));
  } catch (e) {
    logger.error(e, 'ошибка регистрации');
    fail('Не удалось создать аккаунт. Попробуйте ещё раз.');
  }
});

// ── Вход ────────────────────────────────────────────────────────────────────
authRouter.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const notice = req.query.reset ? 'Пароль изменён. Войдите с новым паролем.' : undefined;
  res.send(loginPage({ csrf: res.locals.csrf, base: res.locals.base, notice, ...inviteNotice(req) }));
});

authRouter.post('/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const u = Users.byEmail(email);
  if (!u || !Users.verify(u, password)) {
    return res.status(401).send(loginPage({ csrf: res.locals.csrf, error: 'Неверный email или пароль.', email, base: res.locals.base }));
  }
  Users.touchLogin(u.id);
  setSession(req, u);
  logger.info({ userId: u.id }, 'вход выполнен');
  res.redirect(popReturnTo(req));
});

// ── Выход ───────────────────────────────────────────────────────────────────
authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Восстановление пароля ────────────────────────────────────────────────────
authRouter.get('/forgot', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(forgotPage({ csrf: res.locals.csrf, base: res.locals.base }));
});

authRouter.post('/forgot', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim();
  const u = email && Users.byEmail(email);
  // Ответ всегда нейтральный (не раскрываем, есть ли аккаунт). Ссылку создаём,
  // только если пользователь есть; доставляет её админ (почта — позже).
  if (u) {
    const token = PasswordResets.create(u.id);
    const link = `${req.protocol}://${req.get('host')}${res.locals.base || ''}/reset/${token}`;
    logger.info({ userId: u.id, resetLink: link }, 'создана ссылка сброса пароля (выдаёт админ)');
  } else {
    logger.info({ email }, 'запрос сброса пароля для несуществующего email');
  }
  res.send(forgotSentPage({ base: res.locals.base }));
});

authRouter.get('/reset/:token', (req, res) => {
  const r = PasswordResets.byToken(req.params.token);
  if (!PasswordResets.isValid(r)) return res.status(410).send(resetPage({ csrf: res.locals.csrf, base: res.locals.base, invalid: true }));
  res.send(resetPage({ csrf: res.locals.csrf, base: res.locals.base, token: req.params.token }));
});

authRouter.post('/reset/:token', authLimiter, (req, res) => {
  const r = PasswordResets.byToken(req.params.token);
  if (!PasswordResets.isValid(r)) return res.status(410).send(resetPage({ csrf: res.locals.csrf, base: res.locals.base, invalid: true }));
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  const fail = (error) => res.status(400).send(resetPage({ csrf: res.locals.csrf, base: res.locals.base, token: req.params.token, error }));
  if (password.length < 8) return fail('Пароль должен быть не короче 8 символов.');
  if (password !== password2) return fail('Пароли не совпадают.');
  Users.setPassword(r.user_id, password);
  PasswordResets.use(r.id);
  logger.info({ userId: r.user_id }, 'пароль сброшен по ссылке');
  res.redirect('/login?reset=1');
});

// ── Домашняя (требует входа) ─────────────────────────────────────────────────
authRouter.get('/', requireAuth, (req, res) => {
  const orgs = Orgs.ofUser(req.session.user.id);
  const superAdmin = isSuperAdmin(req.session.user.email);
  res.send(homePage({
    user: req.session.user, orgs, csrf: res.locals.csrf, base: res.locals.base, superAdmin,
    canCreate: Orgs.canCreateCompany(req.session.user.id, superAdmin),
    error: req.query.err === 'nocreate' ? 'Приглашённые участники не могут создавать свою компанию. Обратитесь к владельцу вашей компании или к администратору сервиса.' : undefined,
  }));
});
