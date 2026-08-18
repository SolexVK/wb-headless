// service/views/kit.js — общий UI-набор всех страниц: тема/CSS, layout, мелкие
// боксы (ok/err/note), формат-функции отчётов (nf/fmtHrs/dk*/ph) и детали страниц
// отчётов (whenLabel/downloadBar/runStatus). Выделено из монолитного views.js (P1c).
import { INTERACTIVE_CSS, INTERACTIVE_JS } from '../../scripts/lib/report-interactive.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Палитра как токены. Тёмная тема применяется двумя способами: по системной
// настройке (когда явная тема НЕ выбрана) и при явном выборе data-theme="dark".
// Явный светлый выбор (data-theme="light") оставляет светлые токены :root.
const LIGHT = '--ground:#EDF0F6;--surface:#fff;--surface-2:#F3F7FB;--ink:#141A24;--muted:#57617A;--faint:#8695A6;--line:#E1E7F1;--accent:#4B57C6;--accent-d:#3A45AE;--danger:#C43A50;--ok:#1C8A5B;--radius:12px;--chip-bg:#E9EAFB;--err-bg:#FBE7EA;--err-bd:#F0C4CD;--ok-bg:#E6F5EE;--ok-bd:#BFE6D3;--warn-bg:#FCF3E2;--warn-bd:#F0DCB0;--warn-tx:#8A5A12;--info-bg:#E8EEFF;--info-bd:#C7D6FF;--info-tx:#2A46A8;--b-owner-bg:#E7ECFF;--b-owner-tx:#3A45AE;--b-admin-bg:#E6F0FF;--b-admin-tx:#2563B0;--b-neutral-bg:#EEF1F6;--b-neutral-tx:#57617A;--b-ok-bg:#E6F5EE;--b-ok-tx:#1C8A5B;--b-bad-bg:#F1E7EA;--b-bad-tx:#C43A50;--total:#4338ca;--c-green:#127045;--c-blue:#1d4ed8;--c-violet:#6d28d9;--c-amber:#b45309;--c-teal:#0f766e;--c-red:#be2b41;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s8:#e34948;--ground-2:#E6EBF3;--bg-grad:radial-gradient(1000px 520px at 12% -12%,color-mix(in srgb,var(--accent) 8%,transparent),transparent 62%),radial-gradient(880px 460px at 100% -6%,color-mix(in srgb,#12A67A 6%,transparent),transparent 56%),linear-gradient(180deg,#EFF2F9,#E6EBF3)';
const DARK = '--ground:#0C0F16;--surface:#141926;--surface-2:#1B2130;--ink:#E7ECF5;--muted:#9AA4B8;--faint:#6B7688;--line:#232B3C;--accent:#8E97F5;--accent-d:#A7AEFB;--danger:#F0708A;--ok:#3FBE86;--chip-bg:#1E2340;--err-bg:#2E1620;--err-bd:#5a2733;--ok-bg:#122a20;--ok-bd:#1f4736;--warn-bg:#2c2413;--warn-bd:#514023;--warn-tx:#E3B778;--info-bg:#12203f;--info-bd:#243a63;--info-tx:#9DB4F5;--b-owner-bg:#262c52;--b-owner-tx:#A7AEFB;--b-admin-bg:#1c2c46;--b-admin-tx:#8FB6F0;--b-neutral-bg:#232B3C;--b-neutral-tx:#9AA4B8;--b-ok-bg:#123021;--b-ok-tx:#5FD39C;--b-bad-bg:#3a2029;--b-bad-tx:#E98AA0;--total:#a5b4fc;--c-green:#3FBE86;--c-blue:#6ea8fe;--c-violet:#b79cf6;--c-amber:#e3b778;--c-teal:#4bc3b6;--c-red:#f0708a;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#2f9e2f;--s7:#9085e9;--s8:#e66767;--ground-2:#0A0D14;--bg-grad:radial-gradient(1000px 520px at 12% -12%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 62%),radial-gradient(880px 460px at 100% -6%,color-mix(in srgb,#35C77E 10%,transparent),transparent 56%),linear-gradient(180deg,#0E1220,#0A0D14)';
const CSS = `
:root{${LIGHT}}
@media(prefers-color-scheme:dark){:root:not([data-theme]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg-grad),var(--ground);background-attachment:fixed;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.55}
a{color:var(--accent-d);text-decoration:none}a:hover{text-decoration:underline}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line);background:var(--surface);flex-wrap:wrap;gap:8px}
.top .brand{font-weight:750;letter-spacing:-.01em;color:var(--ink)}.top .brand:hover{text-decoration:none}.top .brand span{color:var(--accent-d)}
.top form{margin:0}
.wrap{max-width:960px;margin:0 auto;padding:28px 22px}
.center{min-height:calc(100vh - 0px);display:grid;place-items:center;padding:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:26px;box-shadow:0 1px 2px rgba(20,26,36,.05),0 8px 26px rgba(20,26,36,.06)}
.auth{width:100%;max-width:400px}
h1{margin:0 0 4px;font-size:22px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:14px;margin:0 0 20px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 5px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--ground);color:var(--ink);font-size:14px}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.btn{margin-top:20px;width:100%;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#fff;font-size:15px;font-weight:650;cursor:pointer}
.btn:hover{background:var(--accent-d)}
.btn-sm{width:auto;padding:7px 13px;margin:0;font-size:13px;background:transparent;color:var(--accent-d);border:1px solid var(--line)}
.alt{margin-top:16px;font-size:13.5px;color:var(--muted);text-align:center}
.err{background:var(--err-bg);color:var(--danger);border:1px solid var(--err-bd);border-radius:9px;padding:10px 12px;font-size:13.5px;margin-bottom:6px}
.grid{display:grid;gap:14px;grid-template-columns:1fr 1fr}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.tile h3{margin:0 0 4px;font-size:15px}.tile p{margin:0;color:var(--muted);font-size:13px}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:var(--chip-bg);color:var(--accent-d)}
.muted{color:var(--muted)} .soon{opacity:.6}
.ok{background:var(--ok-bg);color:var(--ok);border:1px solid var(--ok-bd);border-radius:9px;padding:10px 12px;font-size:13.5px;margin-bottom:12px;word-break:break-word}
.warn{background:var(--warn-bg);color:var(--warn-tx);border:1px solid var(--warn-bd);border-radius:9px;padding:9px 12px;font-size:13px;margin-bottom:10px}
h2{font-size:17px;letter-spacing:-.01em;margin:26px 0 10px}
.section{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:16px}
.section h2{margin-top:0}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:700}
tr:last-child td{border-bottom:0}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--chip-bg);color:var(--accent-d)}
.badge.owner{background:var(--b-owner-bg);color:var(--b-owner-tx)}.badge.admin{background:var(--b-admin-bg);color:var(--b-admin-tx)}.badge.member{background:var(--b-neutral-bg);color:var(--b-neutral-tx)}
.badge.on{background:var(--b-ok-bg);color:var(--b-ok-tx)}.badge.off{background:var(--b-bad-bg);color:var(--b-bad-tx)}
.kv{font-size:12.5px;color:var(--muted)}.kv b{color:var(--ink);font-weight:600}
.row-form{display:flex;gap:8px;align-items:end;flex-wrap:wrap}
.row-form label{margin:0}.row-form input,.row-form select{width:auto}
.row-form input[type=text],.row-form input[type=email]{min-width:220px}
textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--ground);color:var(--ink);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-height:74px;resize:vertical}
select{padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--ground);color:var(--ink);font-size:14px}
.btn-danger{background:transparent;color:var(--danger);border:1px solid var(--err-bd)}
.btn-danger:hover{background:var(--err-bg)}
.mini{font-size:12px;padding:5px 10px;margin:0;width:auto;display:inline-block}
.linkbox{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--ground);border:1px solid var(--line);border-radius:8px;padding:8px 10px;word-break:break-all;margin-top:6px}
.crumbs{font-size:13px;margin-bottom:4px}
.scopes span{display:inline-block;font-size:11px;padding:1px 7px;border-radius:6px;background:var(--ground);border:1px solid var(--line);margin:2px 3px 0 0}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:4px 0 14px}
.tilek{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:118px}
.tilek .n{font-size:22px;font-weight:750;letter-spacing:-.02em}.tilek .l{font-size:12px;color:var(--muted)}
details{margin:10px 0;border:1px solid var(--line);border-radius:10px;padding:6px 14px;background:var(--surface)}
summary{cursor:pointer;font-weight:600;font-size:14px;padding:6px 0}
.badge.st-gap{background:var(--b-bad-bg);color:var(--b-bad-tx)}.badge.st-risk{background:var(--warn-bg);color:var(--warn-tx)}.badge.st-ok{background:var(--b-ok-bg);color:var(--b-ok-tx)}.badge.st-dead{background:var(--b-neutral-bg);color:var(--b-neutral-tx)}
.dl{display:inline-block;margin:0 8px 8px 0;padding:8px 12px;border:1px solid var(--line);border-radius:9px;font-size:13px;font-weight:600;background:var(--surface);color:var(--accent-d)}
.dl:hover{text-decoration:none;border-color:var(--accent)}
.running{background:var(--info-bg);border:1px solid var(--info-bd);color:var(--info-tx);border-radius:9px;padding:11px 13px;margin-bottom:12px;font-size:13.5px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mv-bar{display:flex;flex-wrap:wrap;align-items:center;gap:0 4px;margin:2px 0 12px}
.mv-seg{display:inline-flex;align-items:center;gap:5px;margin:0 16px 8px 0}
.mv-seg .lab{font-size:11px;color:var(--muted);margin-right:3px}
.mv-chip{padding:3px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px;text-decoration:none;color:var(--ink);background:var(--surface)}
.mv-chip:hover{border-color:var(--accent);text-decoration:none}
.mv-chip.on{background:var(--accent);color:#fff;border-color:transparent}
.mv-chart{width:100%;height:auto;display:block;margin:4px 0 6px}
.mv-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:2px 0 6px;font-size:12px;color:var(--muted)}
.mv-legend span{display:inline-flex;align-items:center;gap:5px}
.mv-legend i{width:11px;height:3px;border-radius:2px;display:inline-block}
/* Дашборд-стиль внутри отчётов: KPI-карточки, инсайты, шапки блоков. */
.dk-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:2px 0 16px}
.dk-kpi{position:relative;background:linear-gradient(180deg,color-mix(in srgb,var(--kc) 8%,var(--surface)),var(--surface));border:1px solid var(--line);border-top:3px solid var(--kc);border-radius:14px;padding:14px 15px;overflow:hidden}
.dk-kpi .ic{position:absolute;top:11px;right:11px;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;background:color-mix(in srgb,var(--kc) 15%,var(--surface))}
.dk-kpi .n{font-size:22px;font-weight:750;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--kc);padding-right:30px;line-height:1.06;word-break:break-word}
.dk-kpi .l{margin-top:5px;font-size:11.5px;color:var(--muted)}
.dk-insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin:0 0 16px}
.dk-insight{display:flex;align-items:center;gap:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--kc) 9%,var(--surface)),var(--surface));border:1px solid var(--line);border-left:4px solid var(--kc);border-radius:12px;padding:11px 13px;font-size:12.5px}
.dk-insight .ic{font-size:18px;flex:none;line-height:1} .dk-insight .tx{color:var(--muted)} .dk-insight .tx b{color:var(--kc);font-weight:750}
.ph{display:flex;align-items:center;gap:10px;margin:0 0 13px;padding-bottom:11px;border-bottom:1px solid var(--line)}
.ph .ic{width:30px;height:30px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;font-size:16px;background:color-mix(in srgb,var(--pc) 14%,var(--surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pc) 24%,transparent)}
.ph h2{margin:0;font-size:15.5px;font-weight:750} .ph .sub{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap} .ph .sub b{color:var(--ink)}
.geobars{display:flex;flex-direction:column;gap:7px;margin:2px 0 6px}
.geobar{display:grid;grid-template-columns:minmax(120px,210px) 1fr minmax(56px,auto);align-items:center;gap:11px}
.geobar .gl{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.geobar .gt{background:var(--surface-2);border-radius:6px;height:15px;overflow:hidden}
.geobar .gf{display:block;height:100%;border-radius:6px;min-width:2px}
.geobar .gv{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
/* Таблицы отчётов: заголовки по центру (гориз.+верт.), данные по центру, кроме .tl (Цвет/Статус — слева). */
.rt th,.rt td{text-align:center;vertical-align:middle}
.rt td.tl{text-align:left}
.rt .num{text-align:center;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
.note{background:var(--info-bg);border:1px solid var(--info-bd);color:var(--info-tx);border-radius:9px;padding:10px 12px;margin-bottom:12px;font-size:13.5px}
.gloss{margin:2px 0 0}.gloss dt{font-weight:700;font-size:13px;margin-top:9px}.gloss dd{margin:1px 0 0;color:var(--muted);font-size:12.5px}
.theme-sel{padding:6px 8px;font-size:12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
th[title],label[title],.hashelp{cursor:help;border-bottom:1px dotted transparent}
th[title]{text-decoration:underline dotted 1px;text-underline-offset:3px}
`;

function layout({ title, body, user, csrf, base = '', head = '' }) {
  const u = (p) => base + p;
  const theme = (user && ['light', 'dark', 'system'].includes(user.theme)) ? user.theme : 'system';
  const themeAttr = theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : '';
  const opt = (v, label) => `<option value="${v}"${theme === v ? ' selected' : ''}>${label}</option>`;
  const themeCtl = user
    ? `<form method="post" action="${u('/theme')}" style="margin:0">${csrfField(csrf)}
        <select name="theme" class="theme-sel" title="Тема оформления" onchange="this.form.submit()" aria-label="Тема">
          ${opt('system', 'Тема: системная')}${opt('light', 'Тема: светлая')}${opt('dark', 'Тема: тёмная')}
        </select></form>`
    : '';
  const nav = user
    ? `<div class="top"><a class="brand" href="${u('/')}">FBS<span>·</span>сервис</a>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span class="muted" style="font-size:13px">${esc(user.email)}</span>
          ${themeCtl}
          <form method="post" action="${u('/logout')}">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Выйти</button></form>
        </div></div>`
    : '';
  return `<!doctype html><html lang="ru"${themeAttr}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${head}<title>${esc(title)}</title>
<style>${CSS}${INTERACTIVE_CSS}</style></head><body>${nav}${body}<script>${INTERACTIVE_JS}</script></body></html>`;
}

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const errBox = (e) => (e ? `<div class="err">${esc(e)}</div>` : '');
const noteBox = (m) => (m ? `<div class="note">${esc(m)}</div>` : ''); // текст экранируется
// Заголовок таблицы с всплывающей подсказкой (title). cls — доп. класс (напр. num).
const thT = (label, title, cls = '') => `<th${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</th>`;

const roleRu = (r) => ({ owner: 'владелец', admin: 'админ', member: 'участник' }[r] || r);

// Кнопка-форма (POST + CSRF) для одиночных действий. action уже с префиксом base.
function formBtn(csrf, action, label, cls = 'mini btn-sm', confirm) {
  const onsubmit = confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : '';
  return `<form method="post" action="${action}" style="display:inline-block;margin:0 0 0 6px"${onsubmit}>${csrfField(csrf)}<button class="btn ${cls}" type="submit">${esc(label)}</button></form>`;
}
const okBox = (m) => `<div class="ok">${esc(m)}</div>`;
const okOrWarn = (m) => `<div class="warn">${esc(m)}</div>`;

// ── Отчёты ───────────────────────────────────────────────────────────────────
const nf = (n) => (n == null ? '' : Number(n).toLocaleString('ru-RU'));
// Часы → человекочитаемо: до суток «X ч», дальше «Y сут» (для сроков сборки/доставки).
const fmtHrs = (h) => { const v = Number(h) || 0; return v >= 24 ? (v / 24).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' сут' : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ч'; };
// Дашборд-компоненты для страниц отчётов (в стиле HTML-дашбордов/PDF).
const DKAC = { green: 'var(--c-green)', blue: 'var(--c-blue)', violet: 'var(--c-violet)', amber: 'var(--c-amber)', teal: 'var(--c-teal)', red: 'var(--c-red)', indigo: 'var(--total)' };
const dkKpi = (n, label, { icon = '', accent = DKAC.green } = {}) => `<div class="dk-kpi" style="--kc:${accent}">${icon ? `<span class="ic">${icon}</span>` : ''}<div class="n">${esc(String(n))}</div><div class="l">${label}</div></div>`;
const dkInsights = (items) => (items && items.length ? `<div class="dk-insights">${items.filter(Boolean).map((i) => `<div class="dk-insight" style="--kc:${i.accent || DKAC.green}"><span class="ic">${i.icon || '•'}</span><span class="tx">${i.text}</span></div>`).join('')}</div>` : '');
const ph = (icon, title, sub = '', accent = 'var(--accent)') => `<div class="ph" style="--pc:${accent}"><span class="ic">${icon}</span><h2>${esc(title)}</h2>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
const ST = { 'разрыв до поставки': 'st-gap', 'нет остатка': 'st-gap', 'риск разрыва': 'st-risk', 'ок': 'st-ok', 'неликвид': 'st-dead', 'нет данных': 'st-dead' };
const statusBadge = (s) => `<span class="badge ${ST[s] || 'st-dead'}">${esc(s)}</span>`;

// ── Общие детали страниц отчётов (раньше копипастились в каждой странице) ─────
// Подпись «обновлено» из ISO-даты снимка: «2026-08-14 09:30 UTC» (пусто, если нет).
const whenLabel = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') + ' UTC' : '');
// Панель кнопок выгрузки: HTML-дашборд / PDF / Excel / JSON. h(kind) → URL.
const downloadBar = (h) => `<a class="dl" href="${h('html')}">📊 HTML-дашборд</a> <a class="dl" href="${h('pdf')}">📄 PDF</a> <a class="dl" href="${h('xlsx')}">⬇ Excel</a> <a class="dl" href="${h('json')}">⬇ JSON</a>`;
// Плашка статуса фонового пересчёта. verb — что делаем («Считаю движение заказов»),
// hint — вторая строка, errPrefix/doneMsg — тексты по умолчанию (как у большинства отчётов).
function runStatus(job, active, { verb, hint = 'Страница обновится сама.', errPrefix = 'Ошибка: ', doneMsg = 'Готово.' }) {
  if (job && job.state === 'running') return `<div class="running">⏳ ${verb} на токене кабинета «${esc(active.name)}»… ${esc(job.log || '')}<br><span class="muted">${hint}</span></div>`;
  if (job && job.state === 'error') return `<div class="err" style="white-space:pre-wrap">${errPrefix}${esc(job.error || '')}</div>`;
  if (job && job.state === 'done') return okBox(doneMsg);
  return '';
}

export {
  esc, layout, csrfField, errBox, noteBox, thT, roleRu, formBtn, okBox, okOrWarn,
  nf, fmtHrs, DKAC, dkKpi, dkInsights, ph, statusBadge, whenLabel, downloadBar, runStatus,
};
