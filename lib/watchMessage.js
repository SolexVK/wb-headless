// lib/watchMessage.js — текст сообщения в Telegram по итогам проверки.
//
// Два режима: «всё в порядке» (коротко, чтобы не приучать игнорировать бота)
// и «есть проблемы» (по делу: что, сколько, почему и что делать первым).
// Разметка — HTML: Telegram понимает <b>, <i>, <code>, <u>.

const fmt = (v, d = 0) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v) || 0);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ICON = { critical: '🔴', high: '🟠', medium: '🟡', info: 'ℹ️', ok: '✅' };
const WORD = { critical: 'критично', high: 'серьёзно', medium: 'требует внимания', info: 'к сведению' };

const ruDate = (iso) => {
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}`;
};

/** Заголовок и общая сводка — одинаковые в обоих режимах. */
function summaryBlock(summary, period, cur) {
  const lines = [
    `Период ${ruDate(period.d1)}–${ruDate(period.d2)} · строк детализации: ${fmt(summary.rows)}`,
    `Выручка <b>${fmt(summary.revenue)}</b> ${cur} · к перечислению ${fmt(summary.forPay)} ${cur}`,
  ];
  const parts = [];
  if (summary.commission) parts.push(`комиссия ${fmt(summary.commission)}`);
  if (summary.logistics) parts.push(`логистика ${fmt(summary.logistics)}`);
  if (summary.penalties) parts.push(`штрафы ${fmt(summary.penalties)}`);
  if (summary.storage) parts.push(`хранение ${fmt(summary.storage)}`);
  if (summary.acceptance) parts.push(`приёмка ${fmt(summary.acceptance)}`);
  if (summary.deductions) parts.push(`удержания ${fmt(summary.deductions)}`);
  lines.push(`Удержано: ${parts.length ? parts.join(' · ') : 'ничего'} (${fmt(summary.chargesShare, 1)}% выручки)`);
  return lines.join('\n');
}

/**
 * @param {object} p
 * @param {'ok'|'info'|'medium'|'high'|'critical'} p.severity
 * @param {Array}  p.findings
 * @param {object} p.summary
 * @param {{d1:string,d2:string}} p.period
 * @param {string} p.runLabel  «утренняя»/«вечерняя»
 * @param {string} [p.nextRun] когда следующая проверка
 * @param {boolean} [p.hasReport] приложен ли PDF
 */
export function buildMessage({ severity, findings, summary, period, runLabel, nextRun, hasReport, errors = [] }) {
  const cur = summary.currency || '';
  const head = [];

  // Пустая выгрузка — это НЕ «всё в порядке». Если данных нет, надо сказать
  // именно это, иначе сбой сбора выглядит как спокойный день.
  if (severity === 'ok' && !summary.rows) {
    if (errors.length) {
      head.push('⚠️ <b>Wildberries: проверка не выполнена</b>');
      head.push(`<i>${esc(runLabel)} проверка · данные не получены</i>`);
      head.push('');
      head.push('Не удалось выгрузить детализацию, поэтому вывода об удержаниях нет.');
      head.push('Сбои: ' + esc(errors.join('; ')));
      head.push('Проверьте токен WB и доступность API, затем запустите проверку вручную.');
    } else {
      head.push('ℹ️ <b>Wildberries: отчёта за период ещё нет</b>');
      head.push(`<i>${esc(runLabel)} проверка</i>`);
      head.push('');
      head.push(`За ${ruDate(period.d1)}–${ruDate(period.d2)} WB не отдал ни одной строки детализации.`);
      head.push('Обычно это значит, что отчёт за день ещё не закрыт — удержаний тоже не начислено.');
    }
    if (nextRun) head.push(`\nСледующая проверка: ${esc(nextRun)}.`);
    return head.join('\n').trim();
  }

  if (severity === 'ok') {
    head.push(`${ICON.ok} <b>Wildberries: проблемных удержаний нет</b>`);
    head.push(`<i>${esc(runLabel)} проверка</i>`);
    head.push('');
    head.push(summaryBlock(summary, period, cur));
    if (summary.returnsAwaiting) {
      head.push(`Возвратов ждут забора: ${fmt(summary.returnsAwaiting)} — пока в бесплатном окне.`);
    }
    const info = (summary.byReason || []).filter((r) => r.severity === 'info');
    if (info.length) {
      head.push('');
      head.push('Плановые списания: ' + info.map((r) => `${esc(r.reason.split(',')[0])} ${fmt(r.amount)}`).join(' · '));
    }
  } else {
    const total = findings.reduce((s, f) => s + (f.amount || 0), 0);
    const isNew = findings.filter((f) => f.isNew).length;
    head.push(`${ICON[severity]} <b>Wildberries: ${findings.length} ${plural(findings.length, 'проблема', 'проблемы', 'проблем')} на ${fmt(total)} ${cur}</b>`);
    head.push(`<i>${esc(runLabel)} проверка · ${WORD[severity]}${isNew ? ` · новых: ${isNew}` : ''}</i>`);
    head.push('');
    head.push(summaryBlock(summary, period, cur));
    head.push('');

    findings.slice(0, 8).forEach((f, i) => {
      head.push(`${i + 1}. ${ICON[f.severity]} <b>${esc(f.title)}</b>${f.amount ? ` — ${fmt(f.amount)} ${cur}` : ''}${f.isNew ? ' <i>(новое)</i>' : ''}`);
      if (f.what) head.push(`   ${esc(f.what)}`);
      for (const fact of (f.facts || []).slice(0, 4)) head.push(`   • ${esc(fact)}`);
      if (f.actions?.length) head.push(`   <b>Что делать:</b> ${esc(f.actions[0])}`);
      head.push('');
    });
    if (findings.length > 8) head.push(`…и ещё ${findings.length - 8} — в приложенном отчёте.`);
  }

  if (hasReport) head.push('\n📎 Полное расследование — в приложенных файлах.');
  if (errors.length) head.push(`\n⚠️ Сбои при сборе данных: ${esc(errors.join('; '))}`);
  if (nextRun) head.push(`\nСледующая проверка: ${esc(nextRun)}.`);

  return head.join('\n').trim();
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

export { plural };
