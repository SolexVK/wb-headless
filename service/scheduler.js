// service/scheduler.js — ежедневный автоснимок остатков FBS.
// Копит историю в архив (report_runs) для будущей «динамики по фулфилменту».
// Идемпотентно: если снимок остатков за сегодня (UTC) уже есть — пропускаем.
// Проверку гоняем раз в час, поэтому переживает рестарты и не зависит от точного времени.
import { config } from './config.js';
import { logger } from './logger.js';
import { Cabinets, ReportRuns } from './models.js';
import { startStock } from './reports-runner.js';

const HOUR = 60 * 60 * 1000;
const todayUTC = () => new Date().toISOString().slice(0, 10);

function tick() {
  let started = 0;
  for (const cab of Cabinets.allActive()) {
    try {
      const latest = ReportRuns.latest(cab.id, 'stock');
      const lastDate = latest?.createdAt ? String(latest.createdAt).slice(0, 10) : null;
      if (lastDate === todayUTC()) continue; // снимок за сегодня уже есть
      const token = Cabinets.decryptedToken(cab);
      if (!token) continue;
      const { already } = startStock({ id: cab.id }, token, Cabinets.meta(cab), {}, null); // userId=null — системный
      if (!already) started++;
    } catch (e) {
      logger.error({ cabinetId: cab.id, err: e.message }, 'автоснимок остатков: ошибка кабинета');
    }
  }
  if (started) logger.info({ started }, 'автоснимок остатков: запущены пересчёты');
}

export function startAutoSnapshots() {
  if (!config.autoSnapshotStock) { logger.info('автоснимок остатков: выключен'); return; }
  logger.info('автоснимок остатков: включён (ежедневно, проверка раз в час)');
  setTimeout(tick, 30_000).unref?.(); // первая проверка вскоре после старта
  setInterval(tick, HOUR).unref?.();  // затем ежечасно; unref — не держим процесс
}
