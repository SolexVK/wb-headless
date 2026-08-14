// service/reports.js — оболочка отчётов компании (на токене активного кабинета).
// Подсорт с формой + фоновый пересчёт (single-flight). Каждый запуск попадает в
// АРХИВ (report_runs, сжатый снимок). Архив общий для участников компании: можно
// открыть прошлый запуск и скачать его выгрузки (регенерируются из снимка).
import express from 'express';
import { Orgs, Cabinets, ReportRuns } from './models.js';
import { requireAuth } from './security.js';
import { reportsPage, podsortPage, stockPage, movementPage, movementView, archivePage, archiveViewPage } from './views.js';
import { podsortDefaults, normalizePodsort, movementDefaults, normalizeMovement, startPodsort, startStock, startMovement, getJob, buildXlsx, buildStockXlsx, buildMovementXlsx, buildDashboardHtml, buildStockDashboardHtml, buildMovementDashboardHtml, dashboardToPdf } from './reports-runner.js';
import { logger } from './logger.js';

export const reportsRouter = express.Router();

function loadOrg(req, res, next) {
  const orgId = Number(req.params.id);
  const org = Orgs.byId(orgId);
  const role = org && Orgs.roleOf(req.session.user.id, orgId);
  if (!org || !role) return res.status(404).send('Компания не найдена');
  req.org = org; req.role = role;
  next();
}

// Форма из параметров последнего снимка (snapshot.params) либо дефолты.
function formFrom(latest) {
  const d = podsortDefaults();
  const p = latest?.data?.params;
  if (!p) return d;
  return {
    articles: Array.isArray(p.articles) ? p.articles.join(', ') : d.articles,
    velocityDays: p.velocityDays ?? d.velocityDays,
    leadMin: p.leadMin ?? d.leadMin,
    leadMax: p.leadMax ?? d.leadMax,
    cover: p.coverDays ?? d.cover,
    seedMin: p.seedMin ?? d.seedMin,
    historyDays: p.historyDays ?? d.historyDays,
  };
}

// Выгрузка снимка. JSON — для любого отчёта; Excel/HTML-дашборд — пока только подсорт.
async function sendDownload(res, kind, cabId, snapshot, stem, report = 'podsort', opts = {}) {
  if (kind === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.json"`);
    return res.send(JSON.stringify(snapshot, null, 2));
  }
  if (kind === 'xlsx') {
    const file = report === 'stock' ? await buildStockXlsx({ id: cabId }, snapshot)
      : report === 'movement' ? await buildMovementXlsx({ id: cabId }, snapshot, opts.cost || 620)
        : await buildXlsx({ id: cabId }, snapshot);
    return res.download(file, `${stem}.xlsx`);
  }
  if (kind === 'html' || kind === 'pdf') {
    const html = report === 'stock' ? await buildStockDashboardHtml({ id: cabId }, snapshot)
      : report === 'movement' ? await buildMovementDashboardHtml({ id: cabId }, snapshot, opts.cost || 620)
        : await buildDashboardHtml({ id: cabId }, snapshot);
    if (kind === 'html') return res.download(html, `${stem}-dashboard.html`);
    return res.download(await dashboardToPdf(html), `${stem}-dashboard.pdf`);
  }
  return res.status(404).send('Для этого отчёта такой формат недоступен.');
}

// ── Список отчётов ───────────────────────────────────────────────────────────
reportsRouter.get('/org/:id/reports', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  res.send(reportsPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role,
    active: cab ? { id: cab.id, name: cab.name, meta: Cabinets.meta(cab) } : null,
  }));
});

// ── Подсорт: страница (форма + статус + последний результат) ─────────────────
reportsRouter.get('/org/:id/reports/podsort', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'podsort') : null;
  res.send(podsortPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role,
    active: cab ? { id: cab.id, name: cab.name, meta: Cabinets.meta(cab) } : null,
    latest, job: cab ? getJob(cab.id) : null, form: formFrom(latest),
  }));
});

// ── Подсорт: запустить пересчёт (фоново, single-flight) ─────────────────────
reportsRouter.post('/org/:id/reports/podsort/refresh', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  if (!cab) return res.redirect(`/org/${req.org.id}/reports/podsort`);
  const token = Cabinets.decryptedToken(cab);
  if (!token) return res.redirect(`/org/${req.org.id}/reports/podsort`);
  const params = normalizePodsort(req.body);
  const { already } = startPodsort({ id: cab.id }, token, Cabinets.meta(cab), params, req.session.user.id);
  if (already) logger.info({ cabinetId: cab.id }, 'подсорт: пересчёт уже идёт — пропускаю');
  res.redirect(`/org/${req.org.id}/reports/podsort`);
});

// ── Подсорт: выгрузки последнего запуска ─────────────────────────────────────
reportsRouter.get('/org/:id/reports/podsort/download/:kind', requireAuth, loadOrg, async (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'podsort') : null;
  if (!latest?.data) return res.status(404).send('Нет данных — сначала обновите отчёт.');
  try { await sendDownload(res, req.params.kind, cab.id, latest.data, 'fbs-podsort'); }
  catch (e) { logger.error({ err: e.message }, 'подсорт: ошибка выгрузки'); res.status(500).send('Ошибка сборки файла: ' + e.message); }
});

// ── Остатки: страница + пересчёт + выгрузка ─────────────────────────────────
reportsRouter.get('/org/:id/reports/stock', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'stock') : null;
  // Список собранных снимков остатков (для выбора даты) + выбранный из архива.
  const snapshots = cab ? ReportRuns.datesOf(cab.id, 'stock') : [];
  let selected = null;
  const wantId = Number(req.query.run);
  if (cab && wantId && latest && wantId !== latest.id) {
    const run = ReportRuns.byId(wantId);
    if (run && run.cabinetId === cab.id && run.report === 'stock' && run.data) selected = run;
  }
  res.send(stockPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role,
    active: cab ? { id: cab.id, name: cab.name } : null,
    latest, snapshots, selected, job: cab ? getJob(cab.id, 'stock') : null,
  }));
});

reportsRouter.post('/org/:id/reports/stock/refresh', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  if (!cab) return res.redirect(`/org/${req.org.id}/reports/stock`);
  const token = Cabinets.decryptedToken(cab);
  if (!token) return res.redirect(`/org/${req.org.id}/reports/stock`);
  const { already } = startStock({ id: cab.id }, token, Cabinets.meta(cab), {}, req.session.user.id);
  if (already) logger.info({ cabinetId: cab.id }, 'остатки: пересчёт уже идёт — пропускаю');
  res.redirect(`/org/${req.org.id}/reports/stock`);
});

reportsRouter.get('/org/:id/reports/stock/download/:kind', requireAuth, loadOrg, async (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'stock') : null;
  if (!latest?.data) return res.status(404).send('Нет данных — сначала обновите отчёт.');
  try { await sendDownload(res, req.params.kind, cab.id, latest.data, 'fbs-stock', 'stock'); }
  catch (e) { logger.error({ err: e.message }, 'остатки: ошибка выгрузки'); res.status(500).send('Ошибка сборки файла: ' + e.message); }
});

// ── Движение заказов: страница + пересчёт + выгрузка ─────────────────────────
reportsRouter.get('/org/:id/reports/movement', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'movement') : null;
  const form = latest?.data
    ? { days: latest.data.days || movementDefaults().days, articles: (latest.data.articles || []).join(', ') }
    : movementDefaults();
  res.send(movementPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role,
    active: cab ? { id: cab.id, name: cab.name } : null,
    latest, job: cab ? getJob(cab.id, 'movement') : null,
    view: movementView(req.query), form,
  }));
});

reportsRouter.post('/org/:id/reports/movement/refresh', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  if (!cab) return res.redirect(`/org/${req.org.id}/reports/movement`);
  const token = Cabinets.decryptedToken(cab);
  if (!token) return res.redirect(`/org/${req.org.id}/reports/movement`);
  const params = normalizeMovement(req.body);
  const { already } = startMovement({ id: cab.id }, token, Cabinets.meta(cab), params, req.session.user.id);
  if (already) logger.info({ cabinetId: cab.id }, 'движение: пересчёт уже идёт — пропускаю');
  res.redirect(`/org/${req.org.id}/reports/movement`);
});

reportsRouter.get('/org/:id/reports/movement/download/:kind', requireAuth, loadOrg, async (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'movement') : null;
  if (!latest?.data) return res.status(404).send('Нет данных — сначала обновите отчёт.');
  const cost = Math.min(100000, Math.max(0, Math.round(Number(req.query.cost)) || 620));
  try { await sendDownload(res, req.params.kind, cab.id, latest.data, 'fbs-movement', 'movement', { cost }); }
  catch (e) { logger.error({ err: e.message }, 'движение: ошибка выгрузки'); res.status(500).send('Ошибка сборки файла: ' + e.message); }
});

// ── Архив отчётов компании (общий): список запусков ──────────────────────────
reportsRouter.get('/org/:id/reports/archive', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.firstOf(req.org.id);
  const all = cab ? ReportRuns.list(cab.id) : [];
  const types = [...new Set(all.map((r) => r.report))];
  const report = types.includes(req.query.report) ? req.query.report : '';
  const runs = report ? all.filter((r) => r.report === report) : all;
  res.send(archivePage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role, runs, report, types,
  }));
});

// Открыть конкретный архивный запуск (регенерируем вывод из снимка).
reportsRouter.get('/org/:id/reports/archive/:runId', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.firstOf(req.org.id);
  const run = ReportRuns.byId(Number(req.params.runId));
  if (!run || !cab || run.cabinetId !== cab.id) return res.status(404).send('Запуск не найден');
  res.send(archiveViewPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role, run,
  }));
});

// Удалить архивный запуск — только автор (кто создал этот отчёт).
reportsRouter.post('/org/:id/reports/archive/:runId/delete', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.firstOf(req.org.id);
  const run = ReportRuns.byId(Number(req.params.runId));
  if (!run || !cab || run.cabinetId !== cab.id) return res.status(404).send('Запуск не найден');
  if (run.authorId !== req.session.user.id) {
    return res.status(403).send('Удалить отчёт может только тот пользователь, который его создал.');
  }
  ReportRuns.deleteByAuthor(run.id, req.session.user.id);
  logger.info({ runId: run.id, by: req.session.user.id }, 'архив: автор удалил свой запуск');
  res.redirect(`/org/${req.org.id}/reports/archive`);
});

// Выгрузки конкретного архивного запуска.
reportsRouter.get('/org/:id/reports/archive/:runId/download/:kind', requireAuth, loadOrg, async (req, res) => {
  const cab = Cabinets.firstOf(req.org.id);
  const run = ReportRuns.byId(Number(req.params.runId));
  if (!run || !cab || run.cabinetId !== cab.id || !run.data) return res.status(404).send('Запуск не найден');
  const stem = `fbs-${run.report}-${String(run.created_at || run.createdAt || '').slice(0, 10)}`;
  const cost = Math.min(100000, Math.max(0, Math.round(Number(req.query.cost)) || 620));
  try { await sendDownload(res, req.params.kind, cab.id, run.data, stem, run.report, { cost }); }
  catch (e) { logger.error({ err: e.message }, 'архив: ошибка выгрузки'); res.status(500).send('Ошибка сборки файла: ' + e.message); }
});
