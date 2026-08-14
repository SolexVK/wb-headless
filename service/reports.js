// service/reports.js — оболочка отчётов организации. Работают на токене АКТИВНОГО
// кабинета. Первый отчёт — Подсорт (движок scripts/fbs-*.mjs) с формой параметров,
// фоновым пересчётом (single-flight) и выгрузками Excel/HTML/JSON.
import express from 'express';
import { Orgs, Cabinets, Snapshots } from './models.js';
import { requireAuth } from './security.js';
import { reportsPage, podsortPage } from './views.js';
import { podsortDefaults, normalizePodsort, startPodsort, getJob, buildXlsx, buildDashboardHtml } from './reports-runner.js';
import { logger } from './logger.js';

export const reportsRouter = express.Router();

// Загрузить организацию и роль; 404 если не участник (как в orgs.js).
function loadOrg(req, res, next) {
  const orgId = Number(req.params.id);
  const org = Orgs.byId(orgId);
  const role = org && Orgs.roleOf(req.session.user.id, orgId);
  if (!org || !role) return res.status(404).send('Организация не найдена');
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
  const latest = cab ? Snapshots.latest(cab.id, 'podsort') : null;
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
  const { already } = startPodsort({ id: cab.id }, token, Cabinets.meta(cab), params);
  if (already) logger.info({ cabinetId: cab.id }, 'подсорт: пересчёт уже идёт — пропускаю');
  res.redirect(`/org/${req.org.id}/reports/podsort`);
});

// ── Подсорт: выгрузки ────────────────────────────────────────────────────────
reportsRouter.get('/org/:id/reports/podsort/download/:kind', requireAuth, loadOrg, async (req, res) => {
  const cab = Cabinets.activeOf(req.org.id);
  const latest = cab ? Snapshots.latest(cab.id, 'podsort') : null;
  if (!latest?.data) return res.status(404).send('Нет данных — сначала обновите отчёт.');
  const kind = req.params.kind;
  try {
    if (kind === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="fbs-podsort.json"');
      return res.send(JSON.stringify(latest.data, null, 2));
    }
    if (kind === 'xlsx') {
      const file = await buildXlsx({ id: cab.id }, latest.data);
      return res.download(file, 'fbs-podsort.xlsx');
    }
    if (kind === 'html') {
      const file = await buildDashboardHtml({ id: cab.id }, latest.data);
      return res.download(file, 'fbs-podsort-dashboard.html');
    }
  } catch (e) {
    logger.error({ err: e.message }, 'подсорт: ошибка выгрузки');
    return res.status(500).send('Ошибка сборки файла: ' + e.message);
  }
  res.status(404).send('Неизвестный формат');
});
