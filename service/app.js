// service/app.js — сборка Express-приложения (без listen).
// Отдельно от server.js, чтобы тесты могли поднять app на эфемерном порту.
import express from 'express';
import session from 'express-session';
import { config } from './config.js';
import { logger, httpLogger } from './logger.js';
import { SqliteSessionStore } from './db.js';
import { helmetMw, csrf } from './security.js';
import { authRouter } from './auth.js';
import { orgRouter } from './orgs.js';
import { reportsRouter } from './reports.js';

export function buildApp() {
  const app = express();
  app.set('trust proxy', 1);           // за Caddy — доверяем X-Forwarded-*
  app.disable('x-powered-by');

  app.use(httpLogger);
  app.use(helmetMw);
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const base = config.basePath || '';
  const healthz = (req, res) => res.json({ status: 'ok', phase: 1, base: base || '/', ts: new Date().toISOString() });
  // Health-check по корню — без сессии/CSRF (для мониторинга/Caddy, вне префикса).
  app.get('/healthz', healthz);

  // Всё приложение живёт под base (BASE_PATH за Caddy). Сессию/CSRF вешаем ВНУТРИ
  // этого мостика: cookie ограничена path=base, и express-session не создаёт
  // req.session для запросов вне base — иначе CSRF падал бы на них.
  const root = express.Router();
  root.use(session({
    name: 'fbs.sid',
    store: new SqliteSessionStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 24 * 3600 * 1000, path: base || '/' },
  }));
  root.use(csrf);
  // Префикс для ссылок (res.locals.base) и авто-дополнение редиректов на абсолютные пути.
  root.use((req, res, next) => {
    res.locals.base = base;
    if (base) {
      const orig = res.redirect.bind(res);
      res.redirect = (loc) => (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith('//'))
        ? orig(base + loc) : orig(loc);
    }
    next();
  });
  root.get('/healthz', healthz);
  root.use('/', authRouter);
  root.use('/', orgRouter);
  root.use('/', reportsRouter);
  app.use(base || '/', root);

  app.use((req, res) => res.status(404).send('Не найдено'));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    logger.error(err, 'необработанная ошибка');
    res.status(500).send('Внутренняя ошибка сервера');
  });
  return app;
}
