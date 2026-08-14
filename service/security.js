// service/security.js — helmet, rate-limit, CSRF (double-submit по сессии), requireAuth.
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

// CSP: свой origin; наши страницы используют небольшой inline-CSS/JS форм → 'unsafe-inline'
// на style/script. По мере роста заменим на nonce. Внешние источники запрещены.
export const helmetMw = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// Ограничение попыток на авторизацию (на IP).
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Слишком много попыток. Повторите через несколько минут.',
});

// CSRF: токен в сессии, скрытым полем в формах, сверка на небезопасных методах.
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const sent = req.body?._csrf;
    if (!sent || sent !== req.session.csrf) {
      return res.status(403).send('Ошибка проверки формы (CSRF). Обновите страницу и попробуйте снова.');
    }
  }
  next();
}

// Требовать вход.
export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/login');
}
