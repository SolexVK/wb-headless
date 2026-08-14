// service/views.js — минимальный серверный рендер (без шаблонизатора).
// Утилитарные страницы авторизации + заглушка кабинета. Экранируем весь ввод.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--ground:#EDF0F6;--surface:#fff;--ink:#141A24;--muted:#57617A;--line:#E1E7F1;--accent:#4B57C6;--accent-d:#3A45AE;--danger:#C43A50;--ok:#1C8A5B;--radius:12px}
@media(prefers-color-scheme:dark){:root{--ground:#0C0F16;--surface:#141926;--ink:#E7ECF5;--muted:#9AA4B8;--line:#232B3C;--accent:#8E97F5;--accent-d:#A7AEFB}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.55}
a{color:var(--accent-d);text-decoration:none}a:hover{text-decoration:underline}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line);background:var(--surface)}
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
.err{background:#FBE7EA;color:var(--danger);border:1px solid #F0C4CD;border-radius:9px;padding:10px 12px;font-size:13.5px;margin-bottom:6px}
@media(prefers-color-scheme:dark){.err{background:#2E1620;border-color:#5a2733}}
.grid{display:grid;gap:14px;grid-template-columns:1fr 1fr}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.tile h3{margin:0 0 4px;font-size:15px}.tile p{margin:0;color:var(--muted);font-size:13px}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:#E9EAFB;color:var(--accent-d)}
@media(prefers-color-scheme:dark){.pill{background:#1E2340}}
.muted{color:var(--muted)} .soon{opacity:.6}
.ok{background:#E6F5EE;color:var(--ok);border:1px solid #BFE6D3;border-radius:9px;padding:10px 12px;font-size:13.5px;margin-bottom:12px;word-break:break-word}
.warn{background:#FCF3E2;color:#8A5A12;border:1px solid #F0DCB0;border-radius:9px;padding:9px 12px;font-size:13px;margin-bottom:10px}
@media(prefers-color-scheme:dark){.ok{background:#122a20;border-color:#1f4736}.warn{background:#2c2413;border-color:#514023;color:#E3B778}}
h2{font-size:17px;letter-spacing:-.01em;margin:26px 0 10px}
.section{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:16px}
.section h2{margin-top:0}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:700}
tr:last-child td{border-bottom:0}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:#E9EAFB;color:var(--accent-d)}
.badge.owner{background:#E7ECFF;color:#3A45AE}.badge.admin{background:#E6F0FF;color:#2563B0}.badge.member{background:#EEF1F6;color:#57617A}
.badge.on{background:#E6F5EE;color:var(--ok)}.badge.off{background:#F1E7EA;color:var(--danger)}
@media(prefers-color-scheme:dark){.badge{background:#1E2340}.badge.on{background:#123021;color:#5FD39C}.badge.off{background:#3a2029;color:#E98AA0}}
.kv{font-size:12.5px;color:var(--muted)}.kv b{color:var(--ink);font-weight:600}
.row-form{display:flex;gap:8px;align-items:end;flex-wrap:wrap}
.row-form label{margin:0}.row-form input,.row-form select{width:auto}
.row-form input[type=text],.row-form input[type=email]{min-width:220px}
textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--ground);color:var(--ink);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-height:74px;resize:vertical}
select{padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--ground);color:var(--ink);font-size:14px}
.btn-danger{background:transparent;color:var(--danger);border:1px solid #F0C4CD}
.btn-danger:hover{background:#FBE7EA}
.mini{font-size:12px;padding:5px 10px;margin:0;width:auto;display:inline-block}
.linkbox{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--ground);border:1px solid var(--line);border-radius:8px;padding:8px 10px;word-break:break-all;margin-top:6px}
.crumbs{font-size:13px;margin-bottom:4px}
.scopes span{display:inline-block;font-size:11px;padding:1px 7px;border-radius:6px;background:var(--ground);border:1px solid var(--line);margin:2px 3px 0 0}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:4px 0 14px}
.tilek{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:118px}
.tilek .n{font-size:22px;font-weight:750;letter-spacing:-.02em}.tilek .l{font-size:12px;color:var(--muted)}
details{margin:10px 0;border:1px solid var(--line);border-radius:10px;padding:6px 14px;background:var(--surface)}
summary{cursor:pointer;font-weight:600;font-size:14px;padding:6px 0}
.badge.st-gap{background:#F1E7EA;color:var(--danger)}.badge.st-risk{background:#FCF3E2;color:#8A5A12}.badge.st-ok{background:#E6F5EE;color:var(--ok)}.badge.st-dead{background:#EEF1F6;color:#57617A}
@media(prefers-color-scheme:dark){.badge.st-gap{background:#3a2029;color:#E98AA0}.badge.st-risk{background:#2c2413;color:#E3B778}.badge.st-ok{background:#123021;color:#5FD39C}.badge.st-dead{background:#1E2340;color:#9AA4B8}}
.dl{display:inline-block;margin:0 8px 8px 0;padding:8px 12px;border:1px solid var(--line);border-radius:9px;font-size:13px;font-weight:600;background:var(--surface);color:var(--accent-d)}
.dl:hover{text-decoration:none;border-color:var(--accent)}
.running{background:#E8EEFF;border:1px solid #C7D6FF;color:#2A46A8;border-radius:9px;padding:11px 13px;margin-bottom:12px;font-size:13.5px}
@media(prefers-color-scheme:dark){.running{background:#12203f;border-color:#243a63;color:#9DB4F5}}
.num{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
`;

function layout({ title, body, user, csrf, base = '', head = '' }) {
  const u = (p) => base + p;
  const nav = user
    ? `<div class="top"><a class="brand" href="${u('/')}">FBS<span>·</span>сервис</a>
        <div style="display:flex;gap:12px;align-items:center">
          <span class="muted" style="font-size:13px">${esc(user.email)}</span>
          <form method="post" action="${u('/logout')}">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Выйти</button></form>
        </div></div>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${head}<title>${esc(title)}</title>
<style>${CSS}</style></head><body>${nav}${body}</body></html>`;
}

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const errBox = (e) => (e ? `<div class="err">${esc(e)}</div>` : '');

export function loginPage({ csrf, error, email, base = '' }) {
  const u = (p) => base + p;
  return layout({
    title: 'Вход — FBS-сервис', base,
    body: `<div class="center"><div class="card auth">
      <h1>Вход</h1><p class="sub">FBS-сервис отчётов и подсорта</p>
      ${errBox(error)}
      <form method="post" action="${u('/login')}">${csrfField(csrf)}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" value="${esc(email || '')}" required>
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn" type="submit">Войти</button>
      </form>
      <div class="alt">Нет аккаунта? <a href="${u('/register')}">Зарегистрироваться</a></div>
    </div></div>`,
  });
}

export function registerPage({ csrf, error, email, name, base = '' }) {
  const u = (p) => base + p;
  return layout({
    title: 'Регистрация — FBS-сервис', base,
    body: `<div class="center"><div class="card auth">
      <h1>Регистрация</h1><p class="sub">Создаётся аккаунт и ваша организация — потом подключите кабинет WB</p>
      ${errBox(error)}
      <form method="post" action="${u('/register')}">${csrfField(csrf)}
        <label for="name">Имя</label>
        <input id="name" name="name" type="text" autocomplete="name" value="${esc(name || '')}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" value="${esc(email || '')}" required>
        <label for="password">Пароль <span class="muted">(мин. 8 символов)</span></label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <button class="btn" type="submit">Создать аккаунт</button>
      </form>
      <div class="alt">Уже есть аккаунт? <a href="${u('/login')}">Войти</a></div>
    </div></div>`,
  });
}

export function homePage({ user, orgs, csrf, base = '' }) {
  const u = (p) => base + p;
  const orgList = orgs.length
    ? orgs.map((o) => `<a class="tile" href="${u(`/org/${o.id}`)}" style="display:block">
        <h3>${esc(o.name)} <span class="badge ${esc(o.role)}">${esc(roleRu(o.role))}</span></h3>
        <p>Кабинеты, участники и отчёты →</p></a>`).join('')
    : `<div class="tile"><p class="muted">Организаций пока нет.</p></div>`;
  return layout({
    title: 'FBS-сервис',
    user, csrf, base,
    body: `<div class="wrap">
      <h1>Здравствуйте, ${esc(user.name || user.email)}</h1>
      <p class="sub">Ваши организации. Откройте организацию, чтобы подключить кабинет WB и участников.</p>
      <div class="grid">${orgList}</div>
      <div class="tile soon" style="margin-top:16px">
        <h3>Отчёты <span class="pill">скоро</span></h3>
        <p>Подсорт (с формой), Остатки, Передано/Принято, Ретроспектива — Фаза 2.</p>
      </div>
    </div>`,
  });
}

const roleRu = (r) => ({ owner: 'владелец', admin: 'админ', member: 'участник' }[r] || r);

function tokenMetaLine(meta) {
  if (!meta || !meta.checkedAt) return '<span class="muted">токен не привязан</span>';
  const parts = [];
  if (meta.typeName) parts.push(`<b>${esc(meta.typeName)}</b> токен`);
  if (meta.sid) parts.push(`продавец <b>${esc(String(meta.sid).slice(0, 8))}…</b>`);
  if (meta.expiresAt) {
    const d = new Date(meta.expiresAt); const exp = d.getTime() < Date.now();
    parts.push(`до <b>${esc(d.toISOString().slice(0, 10))}</b>${exp ? ' <span class="badge off">истёк</span>' : ''}`);
  }
  if (meta.readOnly) parts.push('только чтение');
  const scopes = (meta.scopeNames || []).map((s) => `<span>${esc(s)}</span>`).join('');
  return `<div class="kv">${parts.join(' · ')}</div>${scopes ? `<div class="scopes" style="margin-top:5px">${scopes}</div>` : ''}`;
}

export function orgPage(p) {
  const { user, csrf, org, role, members, invites, cabinets, base = '' } = p;
  const u = (path) => base + path;
  const manage = role === 'owner' || role === 'admin';

  // Кабинеты.
  const cabRows = cabinets.length ? cabinets.map((c) => `
    <tr>
      <td><b>${esc(c.name)}</b>${c.is_active ? ' <span class="badge on">активный</span>' : ''}</td>
      <td>${c.has_token ? tokenMetaLine(c.meta) : '<span class="badge off">нет токена</span>'}</td>
      <td style="white-space:nowrap;text-align:right">
        ${manage && !c.is_active && c.has_token ? formBtn(csrf, u(`/org/${org.id}/cabinet/${c.id}/activate`), 'Сделать активным', 'mini btn-sm') : ''}
        ${manage ? formBtn(csrf, u(`/org/${org.id}/cabinet/${c.id}/remove`), 'Удалить', 'mini btn-danger', 'Удалить кабинет и его токен?') : ''}
      </td>
    </tr>`).join('') : `<tr><td colspan="3" class="muted">Кабинетов пока нет — подключите первый ниже.</td></tr>`;

  const connectForm = manage ? `
    <form method="post" action="${u(`/org/${org.id}/cabinet`)}" style="margin-top:14px">
      ${csrfField(csrf)}
      <label for="cabname">Название кабинета</label>
      <input id="cabname" name="name" type="text" placeholder="Напр. Основной магазин" value="${esc(p.cabForm?.name || '')}">
      ${p.cabForm?.cabinetId ? `<input type="hidden" name="cabinet_id" value="${esc(String(p.cabForm.cabinetId))}">` : ''}
      <label for="cabtoken" style="margin-top:12px">Токен WB API <span class="muted">(Контент + Маркетплейс + Статистика)</span></label>
      <textarea id="cabtoken" name="token" placeholder="eyJhbGciOi..." autocomplete="off" spellcheck="false" required></textarea>
      <p class="kv" style="margin:6px 0 0">Токен проверяется и хранится в зашифрованном виде (AES-256-GCM). Он никогда не отображается и не логируется.</p>
      <button class="btn" type="submit" style="max-width:260px">Проверить и подключить</button>
    </form>` : '<p class="muted">Подключать кабинеты может владелец или админ.</p>';

  // Участники.
  const memRows = members.map((m) => {
    const isMe = m.user_id === user.id;
    const canEdit = manage && m.role !== 'owner' && !isMe;
    const roleCell = canEdit ? `
      <form method="post" action="${u(`/org/${org.id}/member/${m.user_id}/role`)}" class="row-form" style="gap:6px">
        ${csrfField(csrf)}
        <select name="role" onchange="this.form.submit()">
          <option value="member" ${m.role === 'member' ? 'selected' : ''}>участник</option>
          <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>админ</option>
        </select>
      </form>` : `<span class="badge ${esc(m.role)}">${esc(roleRu(m.role))}</span>`;
    return `<tr>
      <td><b>${esc(m.name || m.email)}</b>${isMe ? ' <span class="muted">(вы)</span>' : ''}<div class="kv">${esc(m.email)}</div></td>
      <td>${roleCell}</td>
      <td style="text-align:right">${canEdit ? formBtn(csrf, u(`/org/${org.id}/member/${m.user_id}/remove`), 'Убрать', 'mini btn-danger', 'Убрать участника из организации?') : ''}</td>
    </tr>`;
  }).join('');

  const inviteRows = (invites || []).map((i) => `
    <tr>
      <td>${esc(i.email)}</td>
      <td><span class="badge ${esc(i.role)}">${esc(roleRu(i.role))}</span></td>
      <td class="kv">${esc(String(i.expires_at).slice(0, 10))}</td>
      <td style="text-align:right">${formBtn(csrf, u(`/org/${org.id}/invite/${i.id}/revoke`), 'Отозвать', 'mini btn-sm')}</td>
    </tr>`).join('');

  const inviteSection = manage ? `
    <div class="section">
      <h2>Приглашения</h2>
      ${p.invError ? errBox(p.invError) : ''}${p.invOk ? okBox(p.invOk) : ''}
      <form method="post" action="${u(`/org/${org.id}/invite`)}" class="row-form">
        ${csrfField(csrf)}
        <div><label for="invemail">Email</label><input id="invemail" name="email" type="email" placeholder="user@example.com" required></div>
        <div><label for="invrole">Роль</label>
          <select id="invrole" name="role"><option value="member">участник</option><option value="admin">админ</option></select></div>
        <button class="btn mini" type="submit" style="height:38px">Пригласить</button>
      </form>
      ${inviteRows ? `<table style="margin-top:12px"><thead><tr><th>Email</th><th>Роль</th><th>До</th><th></th></tr></thead><tbody>${inviteRows}</tbody></table>` : ''}
    </div>` : '';

  return layout({
    title: `${org.name} — FBS-сервис`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs"><a href="${u('/')}">← Организации</a></div>
      <h1>${esc(org.name)} <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p><a class="dl" href="${u(`/org/${org.id}/reports`)}">📊 Открыть отчёты</a></p>

      <div class="section">
        <h2>Кабинеты WB</h2>
        ${p.cabError ? errBox(p.cabError) : ''}${(p.cabWarn || []).map(okOrWarn).join('')}${p.cabOk ? okBox(p.cabOk) : ''}
        <table><thead><tr><th>Кабинет</th><th>Токен</th><th></th></tr></thead><tbody>${cabRows}</tbody></table>
        ${connectForm}
      </div>

      <div class="section">
        <h2>Участники</h2>
        ${p.memError ? errBox(p.memError) : ''}${p.memOk ? okBox(p.memOk) : ''}
        <table><thead><tr><th>Пользователь</th><th>Роль</th><th></th></tr></thead><tbody>${memRows}</tbody></table>
      </div>

      ${inviteSection}
    </div>`,
  });
}

export function inviteAcceptPage({ csrf, user, org, invite, already, token, invalid, base = '' }) {
  const u = (p) => base + p;
  const body = invalid
    ? `<h1>Приглашение недействительно</h1><p class="sub">Ссылка истекла или уже использована.</p><div class="alt"><a href="${u('/')}">На главную</a></div>`
    : already
      ? `<h1>Вы уже участник</h1><p class="sub">${esc(org.name)} — вы уже состоите в этой организации.</p><div class="alt"><a href="${u(`/org/${org.id}`)}">Открыть организацию</a></div>`
      : `<h1>Приглашение</h1>
         <p class="sub">Вас приглашают в организацию <b>${esc(org.name)}</b> как <span class="badge ${esc(invite.role)}">${esc(roleRu(invite.role))}</span></p>
         <form method="post" action="${u(`/invite/${esc(token)}/accept`)}">${csrfField(csrf)}
           <button class="btn" type="submit">Принять приглашение</button>
         </form>
         <div class="alt"><a href="${u('/')}">Отказаться</a></div>`;
  return layout({ title: 'Приглашение — FBS-сервис', user, csrf, base, body: `<div class="center"><div class="card auth">${body}</div></div>` });
}

// Кнопка-форма (POST + CSRF) для одиночных действий. action уже с префиксом base.
function formBtn(csrf, action, label, cls = 'mini btn-sm', confirm) {
  const onsubmit = confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : '';
  return `<form method="post" action="${action}" style="display:inline-block;margin:0 0 0 6px"${onsubmit}>${csrfField(csrf)}<button class="btn ${cls}" type="submit">${esc(label)}</button></form>`;
}
const okBox = (m) => `<div class="ok">${esc(m)}</div>`;
const okOrWarn = (m) => `<div class="warn">${esc(m)}</div>`;

// ── Отчёты ───────────────────────────────────────────────────────────────────
const nf = (n) => (n == null ? '' : Number(n).toLocaleString('ru-RU'));
const ST = { 'разрыв до поставки': 'st-gap', 'нет остатка': 'st-gap', 'риск разрыва': 'st-risk', 'ок': 'st-ok', 'неликвид': 'st-dead', 'нет данных': 'st-dead' };
const statusBadge = (s) => `<span class="badge ${ST[s] || 'st-dead'}">${esc(s)}</span>`;

export function reportsPage(p) {
  const { user, csrf, base = '', org, role, active } = p;
  const u = (path) => base + path;
  const cabLine = active
    ? `<p class="kv">Активный кабинет: <b>${esc(active.name)}</b>${active.meta?.sid ? ` · продавец ${esc(String(active.meta.sid).slice(0, 8))}…` : ''}</p>`
    : `<div class="warn">Нет активного кабинета с токеном. <a href="${u(`/org/${org.id}`)}">Подключите кабинет</a> и сделайте его активным.</div>`;
  const card = (href, title, desc, ready) => ready
    ? `<a class="tile" href="${u(href)}" style="display:block"><h3>${esc(title)}</h3><p>${esc(desc)} →</p></a>`
    : `<div class="tile soon"><h3>${esc(title)} <span class="pill">скоро</span></h3><p>${esc(desc)}</p></div>`;
  return layout({
    title: `Отчёты — ${org.name}`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs"><a href="${u(`/org/${org.id}`)}">← ${esc(org.name)}</a></div>
      <h1>Отчёты</h1>
      ${cabLine}
      <div class="grid" style="margin-top:14px">
        ${card(`/org/${org.id}/reports/podsort`, 'Подсорт', 'Рекомендации к заказу по складам и размерам + пробный завоз', !!active)}
        ${card(`/org/${org.id}/reports/podsort`, 'Остатки', 'Остатки FBS по артикулам и цветам', false)}
      </div>
    </div>`,
  });
}

export function podsortPage(p) {
  const { user, csrf, base = '', org, role, active, latest, job, form } = p;
  const u = (path) => base + path;
  const back = `<div class="crumbs"><a href="${u(`/org/${org.id}/reports`)}">← Отчёты</a></div>`;

  if (!active) {
    return layout({
      title: `Подсорт — ${org.name}`, user, csrf, base,
      body: `<div class="wrap">${back}<h1>Подсорт</h1>
        <div class="warn">Нет активного кабинета с токеном. <a href="${u(`/org/${org.id}`)}">Подключите кабинет</a> и сделайте его активным.</div></div>`,
    });
  }

  const running = job && job.state === 'running';
  const meta = running ? '<meta http-equiv="refresh" content="4">' : '';
  let statusBox = '';
  if (running) statusBox = `<div class="running">⏳ Идёт пересчёт на токене кабинета «${esc(active.name)}»… ${esc(job.log || '')}<br><span class="muted">Страница обновится сама. Это может занять 1–3 минуты (запрос к WB).</span></div>`;
  else if (job && job.state === 'error') statusBox = `<div class="err" style="white-space:pre-wrap">Ошибка пересчёта: ${esc(job.error || '')}</div>`;
  else if (job && job.state === 'done') statusBox = okBox('Пересчёт завершён.');

  // Форма параметров.
  const f = form;
  const field = (name, label, val, hint) => `<div><label for="${name}">${esc(label)}${hint ? ` <span class="muted">${esc(hint)}</span>` : ''}</label>
    <input id="${name}" name="${name}" type="number" min="1" value="${esc(String(val))}" style="width:110px"></div>`;
  const formSection = `
    <div class="section">
      <h2>Параметры расчёта</h2>
      <form method="post" action="${u(`/org/${org.id}/reports/podsort/refresh`)}">
        ${csrfField(csrf)}
        <label for="articles">Артикулы в работе <span class="muted">(номера через запятую; пусто — по умолчанию)</span></label>
        <input id="articles" name="articles" type="text" value="${esc(f.articles)}" placeholder="002, 003, 023 …">
        <div class="row-form" style="margin-top:12px;gap:14px">
          ${field('velocityDays', 'Окно скорости, дн', f.velocityDays)}
          ${field('leadMin', 'Лид мин, дн', f.leadMin)}
          ${field('leadMax', 'Лид макс, дн', f.leadMax)}
          ${field('cover', 'Запас, дн', f.cover)}
          ${field('seedMin', 'Завоз/размер', f.seedMin)}
          ${field('historyDays', 'История, дн', f.historyDays)}
        </div>
        <button class="btn" type="submit" style="max-width:280px;margin-top:18px"${running ? ' disabled' : ''}>${running ? 'Идёт пересчёт…' : 'Обновить данные'}</button>
      </form>
    </div>`;

  // Результаты последнего снимка.
  let results = `<div class="section"><p class="muted">Данных пока нет — нажмите «Обновить данные», чтобы рассчитать подсорт на токене активного кабинета.</p></div>`;
  if (latest?.data) {
    const s = latest.data;
    const t = s.totals || {};
    const when = latest.refreshedAt ? esc(String(latest.refreshedAt)) + ' UTC' : '';
    const tiles = [
      ['Подсорт, шт', t.reorderUnits], ['Строк в риске', t.riskRows],
      ['Пробный завоз, шт', t.seedUnits], ['Складов', t.warehouses], ['Номенклатура', t.nomenclature],
    ].map(([l, n]) => `<div class="tilek"><div class="n">${nf(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

    // Сводная: артикул×цвет×размер × склад.
    const cols = s.warehouseList || [];
    const pivotHead = `<tr><th>Арт</th><th>Цвет</th><th>Разм</th>${cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">Итого</th></tr>`;
    const pivotRows = (s.pivot || []).map((r) => `<tr><td>${esc(r.articleNum)}</td><td>${esc(r.variant)}</td><td>${esc(r.techSize)}</td>${cols.map((c) => `<td class="num">${r.byWarehouse?.[c] ? nf(r.byWarehouse[c]) : ''}</td>`).join('')}<td class="num"><b>${nf(r.total)}</b></td></tr>`).join('');
    const pivotTable = pivotRows
      ? `<div class="scroll"><table><thead>${pivotHead}</thead><tbody>${pivotRows}</tbody></table></div>`
      : '<p class="muted">Подсорт не требуется (0 строк).</p>';

    // Детально по складам.
    const whBlocks = (s.warehouses || []).filter((w) => w.rows?.length).map((w) => `
      <details><summary>${esc(w.name)} — остаток ${nf(w.stockUnits)} · подсорт ${nf(w.reorderUnits)} шт · строк ${w.rows.length}</summary>
        <div class="scroll"><table>
          <thead><tr><th>Арт</th><th>Цвет</th><th>Разм</th><th class="num">Остаток</th><th class="num">/дн</th><th class="num">Дней до 0</th><th class="num">Подсорт</th><th>Статус</th></tr></thead>
          <tbody>${w.rows.map((r) => `<tr><td>${esc(r.articleNum)}</td><td>${esc(r.variant)}</td><td>${esc(r.techSize)}</td><td class="num">${nf(r.stock)}</td><td class="num">${esc(String(r.perDay))}</td><td class="num">${r.daysToZero == null ? '∞' : esc(String(r.daysToZero))}</td><td class="num"><b>${nf(r.reorderQty)}</b></td><td>${statusBadge(r.status)}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>`).join('');

    // Пробный завоз.
    const seedRows = (s.seedGrid || []).map((r) => `<tr><td>${esc(r.articleNum)}</td><td>${esc(r.variant)}</td><td>${esc(r.techSize)}</td><td><span class="badge ${r.kind === 'новинка' ? 'st-ok' : 'st-risk'}">${esc(r.kind)}</span></td><td class="num"><b>${nf(r.seedTotal)}</b></td></tr>`).join('');
    const seedBlock = seedRows
      ? `<details><summary>Пробный завоз — ${nf(t.seedRows)} строк (${nf(t.seedNovelty)} новинок + ${nf(t.seedRefill)} докладок) = ${nf(t.seedUnits)} шт</summary>
          <div class="scroll"><table><thead><tr><th>Арт</th><th>Цвет</th><th>Разм</th><th>Тип</th><th class="num">Кол-во</th></tr></thead><tbody>${seedRows}</tbody></table></div></details>`
      : '';

    results = `<div class="section">
        <h2>Результат <span class="muted" style="font-size:13px;font-weight:400">обновлено ${when}</span></h2>
        <div class="tiles">${tiles}</div>
        <div style="margin-bottom:6px">
          <a class="dl" href="${u(`/org/${org.id}/reports/podsort/download/xlsx`)}">⬇ Excel</a>
          <a class="dl" href="${u(`/org/${org.id}/reports/podsort/download/html`)}">⬇ HTML-дашборд</a>
          <a class="dl" href="${u(`/org/${org.id}/reports/podsort/download/json`)}">⬇ JSON</a>
        </div>
        <h2>Сводная: подсорт по размерам × склад</h2>
        ${pivotTable}
        <h2 style="margin-top:20px">Детально по складам</h2>
        ${whBlocks || '<p class="muted">Нет строк.</p>'}
        ${seedBlock}
      </div>`;
  }

  return layout({
    title: `Подсорт — ${org.name}`, user, csrf, base, head: meta,
    body: `<div class="wrap">${back}
      <h1>Подсорт <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p class="kv">Кабинет: <b>${esc(active.name)}</b>. Расчёт по FF-складам и размерам; лид-тайм и запас задаются ниже.</p>
      ${statusBox}
      ${formSection}
      ${results}
    </div>`,
  });
}
