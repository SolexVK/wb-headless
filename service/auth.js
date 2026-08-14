// service/auth.js — маршруты регистрации / входа / выхода.
import express from 'express';
import { Users, Orgs } from './models.js';
import { authLimiter, requireAuth } from './security.js';
import { loginPage, registerPage, homePage } from './views.js';
import { logger } from './logger.js';

export const authRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const setSession = (req, u) => { req.session.user = { id: u.id, email: u.email, name: u.name }; };

// ── Регистрация ─────────────────────────────────────────────────────────────
authRouter.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(registerPage({ csrf: res.locals.csrf }));
});

authRouter.post('/register', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  const fail = (error) => res.status(400).send(registerPage({ csrf: res.locals.csrf, error, email, name }));

  if (!EMAIL_RE.test(email)) return fail('Введите корректный email.');
  if (password.length < 8) return fail('Пароль должен быть не короче 8 символов.');
  if (Users.byEmail(email)) return fail('Аккаунт с таким email уже существует.');

  try {
    const userId = Users.register(email, password, name);
    const u = Users.byId(userId);
    setSession(req, u);
    logger.info({ userId }, 'зарегистрирован пользователь + организация');
    res.redirect('/');
  } catch (e) {
    logger.error(e, 'ошибка регистрации');
    fail('Не удалось создать аккаунт. Попробуйте ещё раз.');
  }
});

// ── Вход ────────────────────────────────────────────────────────────────────
authRouter.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(loginPage({ csrf: res.locals.csrf }));
});

authRouter.post('/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const u = Users.byEmail(email);
  if (!u || !Users.verify(u, password)) {
    return res.status(401).send(loginPage({ csrf: res.locals.csrf, error: 'Неверный email или пароль.', email }));
  }
  Users.touchLogin(u.id);
  setSession(req, u);
  logger.info({ userId: u.id }, 'вход выполнен');
  res.redirect('/');
});

// ── Выход ───────────────────────────────────────────────────────────────────
authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Домашняя (требует входа) ─────────────────────────────────────────────────
authRouter.get('/', requireAuth, (req, res) => {
  const orgs = Orgs.ofUser(req.session.user.id);
  res.send(homePage({ user: req.session.user, orgs, csrf: res.locals.csrf }));
});
