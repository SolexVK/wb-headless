// service/logger.js — структурное логирование (pino) + HTTP-логи.
// В dev — человекочитаемо; в проде — JSON. WB-токены/пароли НИКОГДА не логируем.
import pino from 'pino';
import pinoHttp from 'pino-http';
import { config } from './config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug'),
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'password', '*.password', 'token', '*.token', 'wb_token_enc'],
    remove: true,
  },
  ...(config.isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

export const httpLogger = pinoHttp({
  logger,
  // Не шумим на статике/health.
  autoLogging: { ignore: (req) => req.url === '/healthz' || req.url.startsWith('/static') },
  serializers: {
    req(req) { return { method: req.method, url: req.url }; },
    res(res) { return { statusCode: res.statusCode }; },
  },
});
