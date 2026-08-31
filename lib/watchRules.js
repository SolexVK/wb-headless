// lib/watchRules.js — правила, по которым сторож решает: «всё в порядке» или
// «есть проблема». Каждое сработавшее правило превращается в находку (finding)
// с фактами и планом действий, из которых потом собирается сообщение и PDF.
//
// Принципы:
//   • Проблема — это не любая строка удержания. Реклама, сторно и компенсации
//     это нормальная работа площадки: они идут в сводку, а не в тревогу.
//   • Незнакомая причина ВСЕГДА проблема: каталог не полон, и молчать нельзя.
//   • Всплеск считается от базовой линии (медиана дневных сумм за baselineDays),
//     иначе обычный рабочий фон каждый раз выглядел бы аварией.
//   • У каждой находки есть ключ (key) — по нему сторож отличает новую проблему
//     от той, о которой уже сообщал утром.

import { classify, severityRank, worstSeverity } from './deductionCatalog.js';
import { analyzeLogistics, analyzeFines } from './forensics.js';

const n = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const day = (v) => String(v ?? '').slice(0, 10);
const round = (v, d = 2) => { const f = 10 ** d; return Math.round((Number(v) || 0) * f) / f; };
const fmt = (v, d = 0) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v) || 0);
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** Сумма удержания в строке по всем колонкам, где WB что-то удерживает. */
const rowCharge = (r) => n(r.penalty) + n(r.deliveryService) + n(r.paidStorage) + n(r.paidAcceptance) + n(r.deduction);

/** Причина строки: bonusTypeName, а если пусто — название операции. */
const reasonOf = (r) => String(r.bonusTypeName || '').trim() || String(r.sellerOperName || '').trim();

/** Вид удержания по тому, какая колонка ненулевая. */
function kindOf(r) {
  if (n(r.penalty)) return 'penalty';
  if (n(r.deliveryService)) return 'logistics';
  if (n(r.paidStorage)) return 'storage';
  if (n(r.paidAcceptance)) return 'acceptance';
  if (n(r.deduction)) return 'deduction';
  return null;
}

const SEV_UP = { info: 'medium', medium: 'high', high: 'critical', critical: 'critical' };

/** Базовая линия: медиана дневных сумм по причине за предыдущий период. */
function baseline(rows) {
  const byReasonDay = new Map();
  for (const r of rows) {
    const amount = rowCharge(r);
    if (!amount) continue;
    const key = reasonOf(r);
    if (!byReasonDay.has(key)) byReasonDay.set(key, new Map());
    const days = byReasonDay.get(key);
    const d = day(r.rrDate);
    days.set(d, (days.get(d) || 0) + amount);
  }
  const out = new Map();
  for (const [reason, days] of byReasonDay) {
    const vals = [...days.values()].sort((a, b) => a - b);
    out.set(reason, { median: vals[Math.floor(vals.length / 2)] || 0, max: vals[vals.length - 1] || 0, days: vals.length });
  }
  return out;
}

/**
 * Строит находки по текущему окну.
 *
 * @param {object} input
 * @param {Array}  input.rows          строки детализации за проверяемое окно
 * @param {Array}  input.baselineRows  строки за предыдущий период (для всплесков)
 * @param {Array}  input.returns       отчёт о возвратах
 * @param {Array}  input.orders        заказы (статистика)
 * @param {Array}  input.fbsOrders     сборочные задания
 * @param {Array}  input.warehouses    склады продавца
 * @param {object} input.thresholds    пороги (config/watch-thresholds.json)
 * @param {object} [input.state]       что уже сообщали раньше
 */
export function buildFindings({ rows = [], baselineRows = [], returns = [], orders = [], fbsOrders = [], warehouses = [], thresholds = {}, state = {}, asOf } = {}) {
  const T = {
    penaltyAmountAlert: 500, penaltyShareOfRevenuePct: 0.5, costShareOfRevenuePct: 45,
    logisticsShareOfRevenuePct: 5, spikeFactor: 3, clusterMinCount: 5, pvzFreeDays: 2,
    pendingLogisticsAlert: 50000, ...thresholds,
  };
  // asOf — момент сбора данных: возраст возвратов считаем от него, а не от «сейчас»,
  // иначе прогон на вчерашнем кэше добавит лишние сутки просрочки.
  const src = { finance: rows, returns, orders, fbsOrders, warehouses, sales: [], asOf };
  const log = analyzeLogistics(src);
  const fines = analyzeFines(src);
  const base = baseline(baselineRows);
  const seen = state.seen || {};
  // Суточная ставка хранения на ПВЗ: в узком окне штрафов может не быть вовсе,
  // тогда берём её из базового периода — иначе в сообщении будет «ставка 0,00».
  const rateFrom = (arr) => {
    const amounts = arr
      .filter((r) => n(r.penalty) > 0 && /хранение возвратов/i.test(r.bonusTypeName || ''))
      .map((r) => n(r.penalty));
    return amounts.length ? round(Math.min(...amounts)) : 0;
  };
  const findings = [];

  // Выручка периода — нужна, чтобы считать доли и не пугать абсолютными числами.
  const sign = (r) => (/возврат/i.test(r.docTypeName || '') || /возврат|сторно продаж/i.test(r.sellerOperName || '') ? -1 : 1);
  const revenue = round(rows.reduce((s, r) => s + sign(r) * n(r.retailAmount), 0));
  const forPay = round(rows.reduce((s, r) => s + sign(r) * n(r.forPay), 0));
  const share = (v) => (revenue > 0 ? round((v / revenue) * 100, 2) : 0);

  // ── Группировка всех удержаний по причине ────────────────────────────────
  const groups = new Map();
  for (const r of rows) {
    const amount = rowCharge(r);
    if (!amount) continue;
    const reason = reasonOf(r) || '(причина не указана)';
    const kind = kindOf(r);
    const entry = classify(reason, kind);
    // Ключ группы — тип из каталога: разные формулировки одной причины
    // («Невыполненный заказ» и «Невыполненный заказ ») должны сложиться.
    const key = entry ? `${kind}|${entry.id}` : `${kind}|${reason}`;
    if (!groups.has(key)) groups.set(key, { reason, kind, entry, amount: 0, count: 0, items: [], reasons: new Set() });
    const g = groups.get(key);
    g.amount += amount;
    g.count += 1;
    g.items.push(r);
    g.reasons.add(reason);
  }

  const summaryRows = [];
  for (const g of [...groups.values()].sort((a, b) => b.amount - a.amount)) {
    const entry = g.entry;
    const isForwardLogistics = g.kind === 'logistics' && !/возврат|отзыв/i.test(g.reason);
    let severity = entry ? entry.severity : 'high';
    const facts = [];
    const actions = entry ? [...entry.fix] : [
      'Разобрать причину вручную: типа нет в каталоге сторожа',
      'Добавить причину в lib/deductionCatalog.js, чтобы дальше распознавалась автоматически',
    ];

    facts.push(`Сумма ${fmt(g.amount, 2)} (${fmt(g.count)} строк, ${share(g.amount)}% выручки)`);

    // Всплеск относительно базовой линии.
    // База сравнения: медиана дневных сумм по любой из формулировок причины.
    const bases = [...g.reasons].map((r) => base.get(r)).filter(Boolean);
    const b = bases.length ? bases.reduce((a, x) => (x.median > a.median ? x : a)) : null;
    // Медиана в копейках — не база: делить на неё бессмысленно (даёт «в 2 000 000×»).
    const meaningful = b && b.median >= Math.max(10, g.amount * 0.01);
    const spike = meaningful && g.amount > b.median * T.spikeFactor;
    if (spike) {
      severity = SEV_UP[severity];
      const factor = g.amount / b.median;
      facts.push(`Всплеск: в ${factor > 50 ? '50+' : round(factor, 1)}× выше обычного дня (медиана ${fmt(b.median, 2)})`);
    } else if (!b && entry?.batched) {
      // Пакетные списания (возвратная логистика) приходят раз в несколько дней:
      // их отсутствие в базовом периоде — не событие, а особенность графика.
      facts.push('Списание пакетное: в базовом периоде пакета не было, сравнивать не с чем');
    } else if (!b && entry && entry.severity !== 'info' && g.amount >= T.penaltyAmountAlert) {
      // «Впервые» поднимаем только на заметных суммах, иначе шум.
      facts.push('В базовом периоде такой причины не было — удержание появилось впервые');
      severity = SEV_UP[severity];
    } else if (!b && entry && entry.severity !== 'info') {
      facts.push('В базовом периоде такой причины не было');
    }

    // Что именно пострадало: артикулы, склады, ПВЗ.
    const arts = uniq(g.items.map((r) => r.vendorCode)).slice(0, 5);
    if (arts.length) facts.push(`Артикулы: ${arts.join(', ')}${g.items.length > 5 ? ' …' : ''}`);
    const dates = uniq(g.items.map((r) => day(r.rrDate))).sort();
    if (dates.length) facts.push(`Даты удержания: ${dates.join(', ')}`);

    summaryRows.push({ reason: g.reason, kind: g.kind, amount: round(g.amount), count: g.count, severity, catalogId: entry?.id || null });

    // info-причины (реклама, сторно, компенсации) — не тревога, если нет всплеска.
    const isProblem = severityRank(severity) <= severityRank('medium');
    if (!isProblem && !spike) continue;
    // Мелочь ниже порога не поднимаем, если это не критический класс.
    if (severityRank(severity) >= severityRank('medium') && g.amount < T.penaltyAmountAlert && !spike) continue;
    // Хвосты в копейки (округления, сторно-остатки) знакомых типов — не событие.
    if (entry && Math.abs(g.amount) < 1) continue;

    const findingKey = `${entry?.id || `unknown:${g.reason}`}|${dates.join(',') || ''}`;
    findings.push({
      key: findingKey,
      severity: isForwardLogistics ? 'high' : severity,
      catalogId: entry?.id || null,
      title: isForwardLogistics
        ? 'Логистика доставки покупателю (при ИУ такого быть не должно)'
        : entry?.title || `Незнакомая причина удержания: ${g.reason}`,
      reason: g.reason,
      amount: round(g.amount),
      count: g.count,
      what: entry?.what || 'Причина отсутствует в каталоге — WB мог ввести новый тип удержания.',
      facts,
      actions,
      isNew: !seen[findingKey],
    });
  }

  // ── Расследование кластеров: отмены заказов ─────────────────────────────
  const c = fines.cancels;
  if (c.material >= T.clusterMinCount) {
    const ff = c.byFf[0];
    const created = c.byCreatedDate[0];
    const f = findings.find((x) => x.catalogId === 'unfulfilled-order');
    const detail = [
      `Кластер: ${fmt(ff?.count || 0)} отмен со склада «${ff?.key}» по заданиям от ${created?.key || '—'}`,
      c.hours ? `Простой до аннулирования: медиана ${fmt(c.hours.median)} ч (${round(c.hours.median / 24, 1)} суток), максимум ${fmt(c.hours.max)} ч` : null,
      c.priceShare ? `Штраф ≈${fmt(c.priceShare.median, 1)}% цены товара` : null,
      `Топ артикулов: ${c.byArticle.slice(0, 3).map((a) => `${a.key} (${a.count})`).join(', ')}`,
    ].filter(Boolean);
    if (f) f.facts.push(...detail);
    else findings.push({
      key: `unfulfilled-order|${created?.key || ''}`, severity: 'critical', catalogId: 'unfulfilled-order',
      title: 'Массовый срыв заказов', reason: 'Невыполненный заказ', amount: round(c.total), count: c.material,
      what: 'Серия отмен по одному складу и одной дате постановки заданий.', facts: detail,
      actions: ['Разобрать инцидент со складом ФФ', 'Ввести контроль возраста сборочного задания'],
      isNew: !seen[`unfulfilled-order|${created?.key || ''}`],
    });
  }

  // ── Возвраты: ждут забора и просроченные ────────────────────────────────
  const aw = fines.awaiting;
  if (aw.expired.count) {
    const key = `returns-expired|${aw.expired.oldest ? day(aw.expired.oldest) : ''}`;
    findings.push({
      key, severity: 'high', catalogId: 'pvz-return-storage',
      title: 'Возвраты с истёкшим сроком хранения на ПВЗ', amount: 0, count: aw.expired.count,
      what: 'Товар пролежал на пункте выдачи дольше срока хранения: его не выдадут в обычном порядке, стоимость единицы под угрозой.',
      facts: [
        `${fmt(aw.expired.count)} позиций, самая давняя готова к выдаче с ${day(aw.expired.oldest) || '—'}`,
        `Очаг: ${String(aw.expired.byPvz[0]?.key || '—').split(',')[0]} (${fmt(aw.expired.byPvz[0]?.count || 0)} шт)`,
      ],
      actions: ['Разобрать эти позиции первыми — там теряется сам товар', 'Уточнить в поддержке WB судьбу просроченных возвратов'],
      isNew: !seen[key],
    });
  }
  if (aw.overdue > 0) {
    const key = `returns-overdue|${new Date(asOf || Date.now()).toISOString().slice(0, 10)}`;
    const dailyRate = fines.storage.dailyRate || rateFrom(baselineRows);
    findings.push({
      key, severity: 'medium', catalogId: 'pvz-return-storage',
      title: 'Возвраты в платной зоне хранения', amount: round(aw.overdue * dailyRate), count: aw.overdue,
      what: 'Возвраты ждут забора дольше бесплатного окна — плата капает посуточно.',
      facts: [
        `${fmt(aw.overdue)} из ${fmt(aw.count)} возвратов лежат дольше ${T.pvzFreeDays} суток`,
        dailyRate
          ? `Ставка ${fmt(dailyRate, 2)} в сутки → ≈${fmt(aw.overdue * dailyRate)} в день`
          : 'Суточной ставки в данных пока нет — сумму покажет первое же начисление',
        `Очаг: ${String(aw.byPvz[0]?.key || '—').split(',')[0]} (${fmt(aw.byPvz[0]?.count || 0)} шт)`,
      ],
      actions: ['Организовать вывоз возвратов сегодня', 'Назначить ответственного и график по каждому ПВЗ'],
      isNew: !seen[key],
    });
  }

  // ── Отложенный «хвост» возвратной логистики ─────────────────────────────
  if (log.pending.forecast >= T.pendingLogisticsAlert) {
    const key = `pending-logistics|${new Date(asOf || Date.now()).toISOString().slice(0, 10)}`;
    findings.push({
      key, severity: 'medium', catalogId: 'return-mp-to-seller',
      title: 'Накоплен хвост неоплаченной возвратной логистики', amount: log.pending.forecast, count: log.pending.count,
      what: 'Возвраты уже выданы, а списание за их перевозку ещё не пришло: сумма спишется ближайшими пакетами.',
      facts: [
        `${fmt(log.pending.count)} выданных возвратов без начисления ≈ ${fmt(log.pending.forecast)} к списанию`,
        log.pending.stale ? `${fmt(log.pending.stale)} из них выданы больше трёх суток назад — списание придёт отдельным пакетом` : null,
        log.pending.quietPvz.length ? `Без начислений в окне: ${log.pending.quietPvz.map((p) => String(p).split(',')[0]).join(', ')} — это лаг закрытия дня, а не бесплатный ПВЗ` : null,
      ].filter(Boolean),
      actions: ['Заложить сумму в план недели', 'Снижать сам поток возвратов: тариф платится за каждую перевозку'],
      isNew: !seen[key],
    });
  }

  // ── Доля удержаний в выручке ────────────────────────────────────────────
  const totalCharges = round([...groups.values()].reduce((s, g) => s + g.amount, 0));
  const commission = round(revenue - forPay);
  const totalWithCommission = round(commission + totalCharges);
  if (revenue > 0 && share(totalWithCommission) > T.costShareOfRevenuePct) {
    const key = `cost-share|${day(rows[0]?.rrDate)}`;
    findings.push({
      key, severity: 'medium', catalogId: null,
      title: 'Площадка забирает больше нормы', amount: totalWithCommission, count: 0,
      what: 'Суммарные удержания вместе с комиссией превысили ориентир по доле выручки.',
      facts: [`${share(totalWithCommission)}% выручки при ориентире ${T.costShareOfRevenuePct}%`,
        `Комиссия ${fmt(commission)}, прочие удержания ${fmt(totalCharges)}`],
      actions: ['Проверить юнит-экономику по топ-артикулам', 'Разобрать самые дорогие статьи из списка выше'],
      isNew: !seen[key],
    });
  }

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.amount - a.amount);

  return {
    findings,
    severity: findings.length ? worstSeverity(findings.map((f) => f.severity)) : 'ok',
    summary: {
      revenue, forPay, commission, totalCharges,
      chargesShare: share(totalWithCommission),
      logistics: log.total, logisticsForward: log.forwardTotal,
      penalties: round(rows.reduce((s, r) => s + n(r.penalty), 0)),
      storage: round(rows.reduce((s, r) => s + n(r.paidStorage), 0)),
      acceptance: round(rows.reduce((s, r) => s + n(r.paidAcceptance), 0)),
      deductions: round(rows.reduce((s, r) => s + n(r.deduction), 0)),
      rows: rows.length,
      byReason: summaryRows,
      returnsAwaiting: aw.count,
      currency: rows[0]?.currency || '',
    },
    log,
    fines,
  };
}

export { rowCharge, reasonOf, kindOf };
