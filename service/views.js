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
`;

function layout({ title, body, user, csrf, base = '' }) {
  const u = (p) => base + p;
  const nav = user
    ? `<div class="top"><a class="brand" href="${u('/')}">FBS<span>·</span>сервис</a>
        <div style="display:flex;gap:12px;align-items:center">
          <span class="muted" style="font-size:13px">${esc(user.email)}</span>
          <form method="post" action="${u('/logout')}">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Выйти</button></form>
        </div></div>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
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
