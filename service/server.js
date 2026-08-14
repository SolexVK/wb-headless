// service/server.js — запуск FBS-сервиса (Фаза 0).
// Слушаем ТОЛЬКО loopback (127.0.0.1:91xx) — наружу публикует Caddy (правила Mac Mini).
import { config } from './config.js';
import { logger } from './logger.js';
import { buildApp } from './app.js';

const app = buildApp();
const server = app.listen(config.port, config.host, () => {
  logger.info({ url: `http://${config.host}:${config.port}${config.basePath || ''}` }, 'FBS-сервис запущен');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { logger.info({ sig }, 'остановка'); server.close(() => process.exit(0)); });
}
