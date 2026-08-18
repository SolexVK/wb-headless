// service/reports.js — оболочка отчётов компании (на токене активного кабинета).
// Подсорт с формой + фоновый пересчёт (single-flight). Каждый запуск попадает в
// АРХИВ (report_runs, сжатый снимок). Архив общий для участников компании: можно
// открыть прошлый запуск и скачать его выгрузки (регенерируются из снимка).
import express from 'express';
import { Orgs, Cabinets, ReportRuns } from './models.js';
import { requireAuth } from './security.js';
import { reportsPage, podsortPage, stockPage, movementPage, movementView, geoPage, geoView, logisticsPage, logisticsView, archivePage, archiveViewPage } from './views.js';
import { podsortDefaults, normalizePodsort, movementDefaults, normalizeMovement, geoDefaults, normalizeGeo, logisticsDefaults, normalizeLogistics, startPodsort, startStock, startMovement, startGeo, startLogistics, getJob, buildXlsx, buildStockXlsx, buildMovementXlsx, buildGeoXlsx, buildLogisticsXlsx, buildDashboardHtml, buildStockDashboardHtml, buildMovementDashboardHtml, buildGeoDashboardHtml, buildLogisticsDashboardHtml, dashboardToPdf } from './reports-runner.js';
import { logger } from './logger.js';
import { REPORT_RU } from './report-names.js';

export const reportsRouter = express.Router();

// Имя файла выгрузки: «Название отчёта дата» (напр. «Подсорт 2026-08-14»).
const fileStem = (report, date) => `${REPORT_RU[report] || report} ${(date && String(date).slice(0, 10)) || new Date().toISOString().slice(0, 10)}`;

// Реестр отчётов: как нормализовать форму, чем запускать пересчёт и чем собирать
// выгрузки. Из него генерятся одинаковые маршруты refresh/download и диспетчер
// sendDownload — раньше это были 5× копипастных триплетов и вложенные тернарии.
const REG = {
  podsort: { normalize: normalizePodsort, start: startPodsort, xlsx: buildXlsx, html: buildDashboardHtml },
  stock: { normalize: () => ({}), start: startStock, xlsx: buildStockXlsx, html: buildStockDashboardHtml },
  movement: { normalize: normalizeMovement, start: startMovement, xlsx: buildMovementXlsx, html: buildMovementDashboardHtml, cost: true },
  geo: { normalize: normalizeGeo, start: startGeo, xlsx: buildGeoXlsx, html: buildGeoDashboardHtml },
  logistics: { normalize: normalizeLogistics, start: startLogistics, xlsx: buildLogisticsXlsx, html: buildLogisticsDashboardHtml },
};

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
    res.attachment(`${stem}.json`); // корректно кодирует кириллицу (filename*)
    return res.send(JSON.stringify(snapshot, null, 2));
  }
  const reg = REG[report];
  if (!reg) return res.status(404).send('Для этого отчёта такой формат недоступен.');
  // Смету (cost) принимают только те сборщики, у которых reg.cost === true (движение).
  const extra = reg.cost ? [opts.cost || 620] : [];
  if (kind === 'xlsx') {
    const file = await reg.xlsx({ id: cabId }, snapshot, ...extra);
    return res.download(file, `${stem}.xlsx`);
  }
  if (kind === 'html' || kind === 'pdf') {
    const html = await reg.html({ id: cabId }, snapshot, ...extra);
    if (kind === 'html') return res.download(html, `${stem}.html`);
    return res.download(await dashboardToPdf(html), `${stem}.pdf`);
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

// ── Остатки: страница ────────────────────────────────────────────────────────
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

// ── Движение заказов: страница ───────────────────────────────────────────────
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

// ── География продаж и возвратов: страница ──────────────────────────────────
reportsRouter.get('/org/:id/reports/geo', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'geo') : null;
  const form = latest?.data ? { days: latest.data.days || geoDefaults().days } : geoDefaults();
  res.send(geoPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role,
    active: cab ? { id: cab.id, name: cab.name } : null,
    latest, job: cab ? getJob(cab.id, 'geo') : null,
    view: geoView(req.query), form,
  }));
});

// ── Логистика (сроки сборки и доставки): страница ────────────────────────────
reportsRouter.get('/org/:id/reports/logistics', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? ReportRuns.latest(cab.id, 'logistics') : null;
  const form = latest?.data ? { days: latest.data.days || logisticsDefaults().days } : logisticsDefaults();
  res.send(logisticsPage({
    user: req.session.user, csrf: res.locals.csrf, base: res.locals.base,
    org: req.org, role: req.role,
    active: cab ? { id: cab.id, name: cab.name } : null,
    latest, job: cab ? getJob(cab.id, 'logistics') : null,
    view: logisticsView(req.query), form,
  }));
});

// ── Пересчёт и выгрузки для всех отчётов — единообразно из реестра REG ────────
// Страницы (GET .../report) остаются раздельными: у каждой свой шаблон и view.
// А «запустить пересчёт» и «скачать последний запуск» устроены одинаково —
// генерируем их в цикле, вместо пяти копипастных пар роутов.
for (const report of Object.keys(REG)) {
  const reg = REG[report];
  const pageUrl = (org) => `/org/${org}/reports/${report}`;

  reportsRouter.post(`/org/:id/reports/${report}/refresh`, requireAuth, loadOrg, (req, res) => {
    const cab = Cabinets.activeOf(req.org.id);
    if (!cab) return res.redirect(pageUrl(req.org.id));
    const token = Cabinets.decryptedToken(cab);
    if (!token) return res.redirect(pageUrl(req.org.id));
    const { already } = reg.start({ id: cab.id }, token, Cabinets.meta(cab), reg.normalize(req.body), req.session.user.id);
    if (already) logger.info({ cabinetId: cab.id, report }, 'пересчёт уже идёт — пропускаю');
    res.redirect(pageUrl(req.org.id));
  });

  reportsRouter.get(`/org/:id/reports/${report}/download/:kind`, requireAuth, loadOrg, async (req, res) => {
    const cab = Cabinets.activeOf(req.org.id);
    const latest = cab ? ReportRuns.latest(cab.id, report) : null;
    if (!latest?.data) return res.status(404).send('Нет данных — сначала обновите отчёт.');
    const cost = Math.min(100000, Math.max(0, Math.round(Number(req.query.cost)) || 620));
    try { await sendDownload(res, req.params.kind, cab.id, latest.data, fileStem(report), report, { cost }); }
    catch (e) { logger.error({ err: e.message, report }, 'ошибка выгрузки'); res.status(500).send('Ошибка сборки файла: ' + e.message); }
  });
}

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

// Массовая очистка архива. Владелец — все авторские запуски компании; остальные — только свои.
// Накопительные снимки по расписанию (user_id IS NULL) не трогаем ни при какой роли.
reportsRouter.post('/org/:id/reports/archive/clear', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.firstOf(req.org.id);
  if (cab) {
    const removed = req.role === 'owner'
      ? ReportRuns.clearAllAuthored(cab.id)
      : ReportRuns.clearOwn(cab.id, req.session.user.id);
    logger.info({ cabinetId: cab.id, by: req.session.user.id, role: req.role, removed }, 'архив: массовая очистка');
  }
  res.redirect(`/org/${req.org.id}/reports/archive`);
});

// Удалить архивный запуск: автор — свой; владелец — любой авторский. Накопительный
// (по расписанию, без автора) не удаляется ни у кого.
reportsRouter.post('/org/:id/reports/archive/:runId/delete', requireAuth, loadOrg, (req, res) => {
  const cab = Cabinets.firstOf(req.org.id);
  const run = ReportRuns.byId(Number(req.params.runId));
  if (!run || !cab || run.cabinetId !== cab.id) return res.status(404).send('Запуск не найден');
  if (run.authorId == null) return res.status(403).send('Накопительный отчёт (собирается по расписанию) удалять нельзя.');
  const isAuthor = run.authorId === req.session.user.id;
  const isOwner = req.role === 'owner';
  if (!isAuthor && !isOwner) return res.status(403).send('Удалить отчёт может его автор или владелец компании.');
  const ok = isAuthor ? ReportRuns.deleteByAuthor(run.id, req.session.user.id) : ReportRuns.deleteAuthored(run.id);
  logger.info({ runId: run.id, by: req.session.user.id, asowner: isOwner && !isAuthor, ok }, 'архив: удалён запуск');
  res.redirect(`/org/${req.org.id}/reports/archive`);
});

// Выгрузки конкретного архивного запуска.
reportsRouter.get('/org/:id/reports/archive/:runId/download/:kind', requireAuth, loadOrg, async (req, res) => {
  const cab = Cabinets.firstOf(req.org.id);
  const run = ReportRuns.byId(Number(req.params.runId));
  if (!run || !cab || run.cabinetId !== cab.id || !run.data) return res.status(404).send('Запуск не найден');
  const stem = fileStem(run.report, run.created_at || run.createdAt);
  const cost = Math.min(100000, Math.max(0, Math.round(Number(req.query.cost)) || 620));
  try { await sendDownload(res, req.params.kind, cab.id, run.data, stem, run.report, { cost }); }
  catch (e) { logger.error({ err: e.message }, 'архив: ошибка выгрузки'); res.status(500).send('Ошибка сборки файла: ' + e.message); }
});
