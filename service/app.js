// service/app.js — сборка Express-приложения (без listen).
// Отдельно от server.js, чтобы тесты могли поднять app на эфемерном порту.
import express from 'express';
import session from 'express-session';
import { config } from './config.js';
import { logger, httpLogger } from './logger.js';
import { SqliteSessionStore } from './db.js';
import { helmetMw, csrf } from './security.js';
import { authRouter } from './auth.js';

export function buildApp() {
  const app = express();
  app.set('trust proxy', 1);           // за Caddy — доверяем X-Forwarded-*
  app.disable('x-powered-by');

  app.use(httpLogger);
  app.use(helmetMw);
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(session({
    name: 'fbs.sid',
    store: new SqliteSessionStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 24 * 3600 * 1000 },
  }));
  app.use(csrf);

  app.get('/healthz', (req, res) => res.json({ status: 'ok', phase: 0, ts: new Date().toISOString() }));
  app.use('/', authRouter);

  app.use((req, res) => res.status(404).send('Не найдено'));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    logger.error(err, 'необработанная ошибка');
    res.status(500).send('Внутренняя ошибка сервера');
  });
  return app;
}
