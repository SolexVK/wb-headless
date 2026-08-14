// service/views.js — минимальный серверный рендер (без шаблонизатора).
// Утилитарные страницы авторизации + заглушка кабинета. Экранируем весь ввод.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Палитра как токены. Тёмная тема применяется двумя способами: по системной
// настройке (когда явная тема НЕ выбрана) и при явном выборе data-theme="dark".
// Явный светлый выбор (data-theme="light") оставляет светлые токены :root.
const LIGHT = '--ground:#EDF0F6;--surface:#fff;--ink:#141A24;--muted:#57617A;--line:#E1E7F1;--accent:#4B57C6;--accent-d:#3A45AE;--danger:#C43A50;--ok:#1C8A5B;--radius:12px;--chip-bg:#E9EAFB;--err-bg:#FBE7EA;--err-bd:#F0C4CD;--ok-bg:#E6F5EE;--ok-bd:#BFE6D3;--warn-bg:#FCF3E2;--warn-bd:#F0DCB0;--warn-tx:#8A5A12;--info-bg:#E8EEFF;--info-bd:#C7D6FF;--info-tx:#2A46A8;--b-owner-bg:#E7ECFF;--b-owner-tx:#3A45AE;--b-admin-bg:#E6F0FF;--b-admin-tx:#2563B0;--b-neutral-bg:#EEF1F6;--b-neutral-tx:#57617A;--b-ok-bg:#E6F5EE;--b-ok-tx:#1C8A5B;--b-bad-bg:#F1E7EA;--b-bad-tx:#C43A50';
const DARK = '--ground:#0C0F16;--surface:#141926;--ink:#E7ECF5;--muted:#9AA4B8;--line:#232B3C;--accent:#8E97F5;--accent-d:#A7AEFB;--chip-bg:#1E2340;--err-bg:#2E1620;--err-bd:#5a2733;--ok-bg:#122a20;--ok-bd:#1f4736;--warn-bg:#2c2413;--warn-bd:#514023;--warn-tx:#E3B778;--info-bg:#12203f;--info-bd:#243a63;--info-tx:#9DB4F5;--b-owner-bg:#262c52;--b-owner-tx:#A7AEFB;--b-admin-bg:#1c2c46;--b-admin-tx:#8FB6F0;--b-neutral-bg:#232B3C;--b-neutral-tx:#9AA4B8;--b-ok-bg:#123021;--b-ok-tx:#5FD39C;--b-bad-bg:#3a2029;--b-bad-tx:#E98AA0';
const CSS = `
:root{${LIGHT}}
@media(prefers-color-scheme:dark){:root:not([data-theme]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.55}
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
.mv-chip.on{background:var(--ink);color:var(--ground);border-color:transparent}
.mv-chart{width:100%;height:auto;display:block;margin:4px 0 6px}
.mv-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:2px 0 6px;font-size:12px;color:var(--muted)}
.mv-legend span{display:inline-flex;align-items:center;gap:5px}
.mv-legend i{width:11px;height:3px;border-radius:2px;display:inline-block}
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
<style>${CSS}</style></head><body>${nav}${body}</body></html>`;
}

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const errBox = (e) => (e ? `<div class="err">${esc(e)}</div>` : '');
const noteBox = (m) => (m ? `<div class="note">${esc(m)}</div>` : ''); // текст экранируется
// Заголовок таблицы с всплывающей подсказкой (title). cls — доп. класс (напр. num).
const thT = (label, title, cls = '') => `<th${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</th>`;

export function loginPage({ csrf, error, email, notice, base = '' }) {
  const u = (p) => base + p;
  return layout({
    title: 'Вход — FBS-сервис', base,
    body: `<div class="center"><div class="card auth">
      <h1>Вход</h1><p class="sub">FBS-сервис отчётов и подсорта</p>
      ${errBox(error)}${noteBox(notice)}
      <form method="post" action="${u('/login')}">${csrfField(csrf)}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" value="${esc(email || '')}" required>
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn" type="submit">Войти</button>
      </form>
      <div class="alt"><a href="${u('/forgot')}">Забыли пароль?</a> · Нет аккаунта? <a href="${u('/register')}">Зарегистрироваться</a></div>
    </div></div>`,
  });
}

export function forgotPage({ csrf, error, email, base = '' }) {
  const u = (p) => base + p;
  return layout({
    title: 'Восстановление пароля — FBS-сервис', base,
    body: `<div class="center"><div class="card auth">
      <h1>Восстановление пароля</h1><p class="sub">Введите email — создадим ссылку для смены пароля</p>
      ${errBox(error)}
      <form method="post" action="${u('/forgot')}">${csrfField(csrf)}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" value="${esc(email || '')}" required>
        <button class="btn" type="submit">Восстановить пароль</button>
      </form>
      <div class="alt"><a href="${u('/login')}">Вернуться ко входу</a></div>
    </div></div>`,
  });
}

export function forgotSentPage({ base = '' }) {
  const u = (p) => base + p;
  return layout({
    title: 'Заявка принята — FBS-сервис', base,
    body: `<div class="center"><div class="card auth">
      <h1>Заявка принята</h1>
      <p class="sub">Если аккаунт с таким email существует, для него создана ссылка сброса пароля (действует 1 час).</p>
      <div class="note">Пока почтовая отправка не подключена, ссылку выдаёт администратор сервиса. Напишите ему — он передаст ссылку для смены пароля.</div>
      <div class="alt"><a href="${u('/login')}">Вернуться ко входу</a></div>
    </div></div>`,
  });
}

export function resetPage({ csrf, token, error, invalid, base = '' }) {
  const u = (p) => base + p;
  if (invalid) {
    return layout({
      title: 'Ссылка недействительна — FBS-сервис', base,
      body: `<div class="center"><div class="card auth">
        <h1>Ссылка недействительна</h1><p class="sub">Ссылка сброса истекла или уже использована.</p>
        <div class="alt"><a href="${u('/forgot')}">Запросить снова</a></div>
      </div></div>`,
    });
  }
  return layout({
    title: 'Новый пароль — FBS-сервис', base,
    body: `<div class="center"><div class="card auth">
      <h1>Новый пароль</h1><p class="sub">Придумайте новый пароль для входа</p>
      ${errBox(error)}
      <form method="post" action="${u(`/reset/${esc(token)}`)}">${csrfField(csrf)}
        <label for="password">Новый пароль <span class="muted">(мин. 8 символов)</span></label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <label for="password2">Повторите пароль</label>
        <input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" required>
        <button class="btn" type="submit">Сохранить пароль</button>
      </form>
    </div></div>`,
  });
}

export function registerPage({ csrf, error, email, name, notice, base = '' }) {
  const u = (p) => base + p;
  return layout({
    title: 'Регистрация — FBS-сервис', base,
    body: `<div class="center"><div class="card auth">
      <h1>Регистрация</h1><p class="sub">Создаётся аккаунт и ваша организация — потом подключите кабинет WB</p>
      ${errBox(error)}${noteBox(notice)}
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

export function homePage({ user, orgs, csrf, base = '', superAdmin, canCreate, error }) {
  const u = (p) => base + p;
  const orgList = orgs.length
    ? orgs.map((o) => `<a class="tile" href="${u(o.role === 'owner' ? `/org/${o.id}` : `/org/${o.id}/reports`)}" style="display:block">
        <h3>${esc(o.name)} <span class="badge ${esc(o.role)}">${esc(roleRu(o.role))}</span></h3>
        <p>${o.role === 'owner' ? 'Кабинет, участники и отчёты' : 'Отчёты компании'} →</p></a>`).join('')
    : `<div class="tile"><p class="muted">Вы пока не состоите ни в одной компании. Создайте свою ниже или, если вас пригласили, откройте ссылку-приглашение снова.</p></div>`;
  // Форму создания компании видит не всякий: приглашённый участник — не может.
  const createForm = canCreate ? `
    <div class="section" style="margin-top:16px">
      <h2>Создать компанию</h2>
      <p class="kv" style="margin:0 0 10px">Новая компания начинается с 1 места (только вы). Расширить лицензию, чтобы приглашать участников, может администратор сервиса.</p>
      <form method="post" action="${u('/company')}" class="row-form">
        ${csrfField(csrf)}
        <div><label for="company" title="Название вашей компании">Название компании</label><input id="company" name="company" type="text" placeholder="Напр. ИП Иванов" style="min-width:240px"></div>
        <button class="btn mini" type="submit" style="height:38px">Создать</button>
      </form>
    </div>` : '';
  return layout({
    title: 'FBS-сервис',
    user, csrf, base,
    body: `<div class="wrap">
      <h1>Здравствуйте, ${esc(user.name || user.email)}</h1>
      <p class="sub">Ваши компании. Откройте компанию, чтобы настроить кабинет WB и работать с отчётами.${superAdmin ? ` <a href="${u('/admin')}">Панель супер-админа →</a>` : ''}</p>
      ${error ? errBox(error) : ''}
      <div class="grid">${orgList}</div>
      ${createForm}
    </div>`,
  });
}

const roleRu = (r) => ({ owner: 'владелец', admin: 'админ', member: 'участник' }[r] || r);

// Глоссарий ролей/кабинета для страницы организации.
function rolesGlossary() {
  const dt = (t, d) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`;
  return `<details style="margin-top:12px"><summary>❓ Пояснения: роли и лицензия</summary>
    <div style="padding:4px 2px 8px"><dl class="gloss">
      ${dt('владелец', 'Держатель лицензии — первый человек компании. Настраивает кабинет и токен, приглашает участников в пределах лицензии. Роль нельзя убрать.')}
      ${dt('участник', 'Приглашённый. Смотрит и запускает отчёты. НЕ видит токен, НЕ настраивает кабинет и НЕ может приглашать других.')}
      ${dt('Места по лицензии', 'Сколько человек всего может быть в компании (включая владельца). Владелец приглашает в пределах этого числа. Меняет лимит только администратор сервиса.')}
      ${dt('Кабинет WB', 'Одна компания = один кабинет WB (один токен). Настраивается один раз владельцем; потом доступно только «Обновить токен».')}
      ${dt('Токен WB API', 'Ключ доступа к API магазина. Нужны категории Контент + Маркетплейс + Статистика, достаточно «только чтение». Хранится зашифрованным, на экран не выводится.')}
    </dl></div>
  </details>`;
}

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

const TOKEN_HELP = `<div class="note">Нужен токен WB API категорий <b>Контент + Маркетплейс + Статистика</b>. Тип токена — <b>персональный</b> или <b>сервисный</b>. Достаточно доступа «<b>Только на чтение</b>» (запись не требуется). Токен хранится в зашифрованном виде (AES-256-GCM), на экран не выводится и в логи не пишется.</div>`;

export function orgPage(p) {
  const { user, csrf, org, role, members, cabinet, seats, base = '' } = p;
  const u = (path) => base + path;
  const owner = role === 'owner';
  const invites = p.invites || [];
  const tokenExpired = cabinet?.meta?.expiresAt ? new Date(cabinet.meta.expiresAt).getTime() < Date.now() : false;

  // ── Вид участника: только название компании и вход в отчёты. Ни участников,
  // ни мест, ни токена, ни приглашений — управленческая информация скрыта.
  if (!owner) {
    const ready = !!cabinet && !tokenExpired;
    const status = !cabinet
      ? '<div class="warn">Кабинет ещё не настроен владельцем — отчёты пока недоступны.</div>'
      : tokenExpired
        ? '<div class="warn">Токен кабинета истёк — отчёты не считаются. Сообщите владельцу компании.</div>'
        : '<p class="kv">Кабинет подключён — отчёты доступны.</p>';
    return layout({
      title: `${org.name} — FBS-сервис`, user, csrf, base,
      body: `<div class="wrap">
        <div class="crumbs"><a href="${u('/')}">← Компании</a></div>
        <h1>${esc(org.name)} <span class="badge member">участник</span></h1>
        ${status}
        ${ready ? `<p><a class="dl" href="${u(`/org/${org.id}/reports`)}">📊 Открыть отчёты</a></p>` : ''}
        <p class="kv" style="margin-top:14px">Вы участник этой компании. Вам доступны отчёты; управление кабинетом и участниками — у владельца.</p>
      </div>`,
    });
  }

  // ── Кабинет компании (одна компания = один кабинет) ──
  let cabinetSection;
  if (!cabinet) {
    cabinetSection = owner ? `
      <div class="section">
        <h2>Настройка компании</h2>
        ${p.cabError ? errBox(p.cabError) : ''}${(p.cabWarn || []).map(okOrWarn).join('')}
        <p class="kv" style="margin:0 0 10px">Разовая настройка: задайте название компании и подключите токен кабинета WB. После этого форма скроется — останется только кнопка «Обновить токен».</p>
        <form method="post" action="${u(`/org/${org.id}/cabinet`)}">
          ${csrfField(csrf)}
          <label for="company" title="Название вашей компании — как она будет называться в сервисе">Название компании</label>
          <input id="company" name="company" type="text" value="${esc(p.setupForm?.company ?? org.name)}" placeholder="Напр. ИП Иванов">
          <label for="cabtoken" style="margin-top:12px" title="JWT-токен WB API с категориями Контент+Маркетплейс+Статистика">Токен WB API</label>
          <textarea id="cabtoken" name="token" placeholder="eyJhbGciOi..." autocomplete="off" spellcheck="false" required></textarea>
          ${TOKEN_HELP}
          <button class="btn" type="submit" style="max-width:280px">Проверить и сохранить</button>
        </form>
      </div>`
      : `<div class="section"><h2>Кабинет WB</h2><p class="muted">Компания ещё не настроена владельцем. Как только владелец подключит кабинет — отчёты станут доступны.</p></div>`;
  } else {
    // Кабинет есть.
    const refreshForm = owner ? `
      <details ${tokenExpired ? 'open' : ''} style="margin-top:12px">
        <summary>Обновить токен${tokenExpired ? ' — требуется (истёк)' : ''}</summary>
        <form method="post" action="${u(`/org/${org.id}/cabinet`)}" style="padding:6px 2px">
          ${csrfField(csrf)}
          <label for="cabtoken" title="Вставьте новый токен WB API">Новый токен WB API</label>
          <textarea id="cabtoken" name="token" placeholder="eyJhbGciOi..." autocomplete="off" spellcheck="false" required></textarea>
          ${TOKEN_HELP}
          <button class="btn" type="submit" style="max-width:260px">Проверить и обновить</button>
        </form>
      </details>` : '';
    cabinetSection = `
      <div class="section">
        <h2>Кабинет WB</h2>
        ${p.cabError ? errBox(p.cabError) : ''}${(p.cabWarn || []).map(okOrWarn).join('')}${p.cabOk ? okBox(p.cabOk) : ''}
        ${tokenExpired ? `<div class="warn">Токен истёк — отчёты не считаются.${owner ? ' Обновите токен ниже.' : ' Сообщите владельцу компании.'}</div>` : ''}
        <p><b>${esc(cabinet.name)}</b> <span class="badge on">подключён</span></p>
        ${refreshForm}
      </div>`;
  }

  // ── Участники ──
  const memRows = members.map((m) => {
    const isMe = m.user_id === user.id;
    const canRemove = owner && m.role !== 'owner' && !isMe;
    return `<tr>
      <td class="tl"><b>${esc(m.name || m.email)}</b>${isMe ? ' <span class="muted">(вы)</span>' : ''}<div class="kv">${esc(m.email)}</div></td>
      <td><span class="badge ${esc(m.role)}">${esc(roleRu(m.role))}</span></td>
      <td style="text-align:right">${canRemove ? formBtn(csrf, u(`/org/${org.id}/member/${m.user_id}/remove`), 'Убрать', 'mini btn-danger', 'Убрать участника из компании?') : ''}</td>
    </tr>`;
  }).join('');

  const seatLine = `<p class="kv" style="margin:0 0 8px">Места по лицензии: <b>${esc(String(seats.used))}</b> из <b>${esc(String(seats.total))}</b> <span class="muted">(участников ${esc(String(seats.members))}, приглашений ${esc(String(seats.pending))})</span>${owner && !seats.canInvite ? ' — <b>лимит исчерпан</b>' : ''}</p>`;

  // ── Приглашения (только владелец) ──
  const inviteRows = invites.map((i) => `
    <tr>
      <td class="tl">${esc(i.email)}</td>
      <td class="kv">${esc(String(i.expires_at).slice(0, 10))}</td>
      <td style="text-align:right">${formBtn(csrf, u(`/org/${org.id}/invite/${i.id}/revoke`), 'Отозвать', 'mini btn-sm')}</td>
    </tr>`).join('');

  const inviteForm = seats.canInvite ? `
      <form method="post" action="${u(`/org/${org.id}/invite`)}" class="row-form">
        ${csrfField(csrf)}
        <div><label for="invemail" title="Email приглашаемого. Принять приглашение сможет только этот адрес.">Email участника</label><input id="invemail" name="email" type="email" placeholder="manager@example.com" required></div>
        <button class="btn mini" type="submit" style="height:38px">Создать ссылку</button>
      </form>`
    : `<div class="warn">Все места по лицензии заняты (${esc(String(seats.total))}).${seats.pending ? ' Часть мест держат неиспользованные приглашения ниже — отзовите ненужные, чтобы освободить места.' : ''} Для расширения лицензии напишите администратору сервиса.</div>`;

  const inviteSection = owner ? `
    <div class="section">
      <h2>Приглашения <span class="muted" style="font-size:13px;font-weight:400">участники — только просмотр и запуск отчётов</span></h2>
      ${p.invError ? errBox(p.invError) : ''}${p.invOk ? okBox(p.invOk) : ''}
      ${p.inviteCreated ? inviteCreatedBox(p.inviteCreated) : ''}
      <p class="kv" style="margin:0 0 10px">Приглашение — это <b>ссылка</b>: вы создаёте её и отправляете человеку сами (почта/мессенджер). Принять сможет <b>только указанный email</b>. Приглашённый регистрируется этим email и подтверждает вступление; приглашать других он не может.</p>
      ${inviteForm}
      ${inviteRows ? `<table class="rt" style="margin-top:12px"><thead><tr>${thT('Email', 'Кому выписано приглашение')}${thT('До', 'Ссылка действует 7 дней')}<th></th></tr></thead><tbody>${inviteRows}</tbody></table>` : ''}
    </div>` : '';

  const adminLink = p.superAdmin ? ` · <a href="${u('/admin')}">Панель супер-админа</a>` : '';

  return layout({
    title: `${org.name} — FBS-сервис`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs"><a href="${u('/')}">← Компании</a>${adminLink}</div>
      <h1>${esc(org.name)} <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p><a class="dl" href="${u(`/org/${org.id}/reports`)}">📊 Открыть отчёты</a></p>

      ${cabinetSection}

      <div class="section">
        <h2 title="Люди с доступом к компании и их роли">Участники</h2>
        ${p.memError ? errBox(p.memError) : ''}${p.memOk ? okBox(p.memOk) : ''}
        ${seatLine}
        <table class="rt"><thead><tr>${thT('Пользователь', 'Имя и email участника')}${thT('Роль', 'владелец — держатель лицензии: настраивает кабинет и приглашает; участник — смотрит и запускает отчёты')}<th></th></tr></thead><tbody>${memRows}</tbody></table>
        ${rolesGlossary()}
      </div>

      ${inviteSection}
    </div>`,
  });
}

export function inviteAcceptPage({ csrf, user, org, invite, already, mismatch, full, token, invalid, base = '' }) {
  const u = (p) => base + p;
  let body;
  if (invalid) {
    body = `<h1>Приглашение недействительно</h1><p class="sub">Ссылка истекла или уже использована.</p><div class="alt"><a href="${u('/')}">На главную</a></div>`;
  } else if (already) {
    body = `<h1>Вы уже участник</h1><p class="sub">${esc(org.name)} — вы уже состоите в этой компании.</p><div class="alt"><a href="${u(`/org/${org.id}`)}">Открыть компанию</a></div>`;
  } else if (full) {
    body = `<h1>Мест нет</h1><p class="sub">В компании <b>${esc(org.name)}</b> закончились места по лицензии.</p><div class="warn">Попросите владельца компании расширить лицензию, затем откройте ссылку снова.</div><div class="alt"><a href="${u('/')}">На главную</a></div>`;
  } else if (mismatch) {
    // Строгая привязка: аккаунт не совпадает с email приглашения — принять нельзя.
    body = `<h1>Другой аккаунт</h1>
      <p class="sub">Приглашение выписано на <b>${esc(invite.email)}</b>, а вы вошли как <b>${esc(user.email)}</b>.</p>
      <div class="warn">Принять приглашение может только владелец адреса <b>${esc(invite.email)}</b>. Выйдите и войдите (или зарегистрируйтесь) под этим email, затем снова откройте ссылку-приглашение.</div>
      <form method="post" action="${u('/logout')}">${csrfField(csrf)}<button class="btn" type="submit">Выйти</button></form>
      <div class="alt"><a href="${u('/')}">На главную</a></div>`;
  } else {
    body = `<h1>Приглашение</h1>
       <p class="sub">Приглашение для <b>${esc(invite.email)}</b> в организацию <b>${esc(org.name)}</b> как <span class="badge ${esc(invite.role)}">${esc(roleRu(invite.role))}</span></p>
       <p class="kv">Вы вошли как <b>${esc(user.email)}</b>. Нажмите кнопку, чтобы вступить.</p>
       <form method="post" action="${u(`/invite/${esc(token)}/accept`)}">${csrfField(csrf)}
         <button class="btn" type="submit">Принять приглашение</button>
       </form>
       <div class="alt"><a href="${u('/')}">Отказаться</a></div>`;
  }
  return layout({ title: 'Приглашение — FBS-сервис', user, csrf, base, body: `<div class="center"><div class="card auth">${body}</div></div>` });
}

// ── Панель супер-админа: компании (название/лицензия) и пользователи ─────────
export function adminPage({ user, csrf, base = '', orgs, users, resets, resetLink, ok, err }) {
  const u = (p) => base + p;

  const orgRows = orgs.map((o) => `<tr>
    <td class="tl">
      <b>${esc(o.name)}</b>
      <details style="display:inline-block;border:0;padding:0;margin:0 0 0 6px;background:none">
        <summary title="Переименовать компанию" style="display:inline;padding:0">✏️</summary>
        <form method="post" action="${u(`/admin/org/${o.id}/rename`)}" class="row-form" style="gap:6px;margin-top:6px">
          ${csrfField(csrf)}
          <input name="name" type="text" value="${esc(o.name)}" style="min-width:180px" aria-label="Название компании">
          <button class="btn mini" type="submit" style="height:34px">Сохранить</button>
        </form>
      </details>
      <div class="kv">${esc(o.owner_email)}</div>
    </td>
    <td>
      <details style="border:0;padding:0;background:none;display:inline-block">
        <summary style="padding:0" title="Показать участников с ролями">${esc(String(o.members))}${o.pending ? ` <span class="muted">(+${esc(String(o.pending))})</span>` : ''}</summary>
        <div style="margin-top:6px;text-align:left">
          ${(o.memberList || []).map((m) => `<div class="kv" style="margin-top:2px"><span class="badge ${esc(m.role)}">${esc(roleRu(m.role))}</span> ${esc(m.email)}</div>`).join('')}
        </div>
      </details>
    </td>
    <td>
      <form method="post" action="${u(`/admin/org/${o.id}/seats`)}" class="row-form" style="gap:6px;justify-content:center">
        ${csrfField(csrf)}
        <input name="seats" type="number" min="1" value="${esc(String(o.license_seats))}" style="width:76px" aria-label="Мест">
        <button class="btn mini" type="submit" style="height:34px">OK</button>
      </form>
    </td>
    <td style="text-align:right">${formBtn(csrf, u(`/admin/org/${o.id}/delete`), 'Отозвать лицензию', 'mini btn-danger', `Отозвать лицензию и удалить компанию «${o.name}» со всеми данными? Пользователи останутся.`)}</td>
  </tr>`).join('');

  const userRows = users.map((usr) => {
    const isMe = usr.id === user.id;
    return `<tr>
      <td class="tl"><b>${esc(usr.name || '—')}</b><div class="kv">${esc(usr.email)}</div></td>
      <td class="kv">${esc(String(usr.created_at).slice(0, 10))}</td>
      <td>${esc(String(usr.owns))} / ${esc(String(usr.memberships))}</td>
      <td style="text-align:right;white-space:nowrap">
        ${formBtn(csrf, u(`/admin/user/${usr.id}/reset`), 'Сброс пароля', 'mini btn-sm')}
        ${isMe ? '<span class="muted" style="margin-left:6px">это вы</span>' : formBtn(csrf, u(`/admin/user/${usr.id}/delete`), 'Удалить', 'mini btn-danger', `Полностью удалить пользователя ${usr.email}? Система забудет его (включая email), его компании будут удалены. Отменить нельзя.`)}
      </td>
    </tr>`;
  }).join('');

  const resetLinkBox = resetLink
    ? `<div class="ok">Ссылка сброса пароля для <b>${esc(resetLink.email)}</b> (действует 1 час). Передайте её человеку:
        <div style="margin-top:8px"><a href="${esc(resetLink.url)}" style="font-weight:600;word-break:break-all">${esc(resetLink.url)}</a></div>
        <input class="linkbox" style="width:100%;margin-top:8px" readonly value="${esc(resetLink.url)}" onclick="this.select()" aria-label="Ссылка сброса пароля"></div>`
    : '';
  const resetRows = (resets || []).map((rr) => `<tr>
      <td class="tl">${esc(rr.email)}</td>
      <td class="kv">${esc(String(rr.created_at).slice(0, 16).replace('T', ' '))}</td>
      <td class="tl"><a href="${esc(rr.url)}" style="word-break:break-all">${esc(rr.url)}</a></td>
    </tr>`).join('');
  const resetSection = (resets && resets.length)
    ? `<div class="section"><h2>Запросы на сброс пароля</h2>
        <p class="kv" style="margin:0 0 8px">Пользователи запросили сброс через «Забыли пароль?». Передайте им ссылку (действует 1 час).</p>
        <div class="scroll"><table class="rt"><thead><tr>${thT('Email', 'Кто запросил')}${thT('Когда', 'Время запроса')}${thT('Ссылка сброса', 'Передайте пользователю')}</tr></thead><tbody>${resetRows}</tbody></table></div></div>`
    : '';

  return layout({
    title: 'Панель супер-админа', user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs"><a href="${u('/')}">← Компании</a></div>
      <h1>Панель супер-админа</h1>
      <p class="sub">Управление всеми компаниями (название, лицензия) и пользователями сервиса.</p>
      ${ok ? okBox('Сохранено.') : ''}${err === 'self' ? errBox('Нельзя удалить самого себя.') : ''}${err === 'name' ? errBox('Введите название компании.') : ''}${err === 'nouser' ? errBox('Пользователь не найден.') : ''}
      ${resetLinkBox}

      <div class="section">
        <h2>Компании</h2>
        <div class="scroll"><table class="rt">
          <thead><tr>${thT('Компания', 'Название (✏️ — переименовать) и email владельца')}${thT('Участников', 'Сейчас в компании + непринятые приглашения')}${thT('Мест', 'Число мест по лицензии — владелец приглашает в пределах этого числа')}${thT('Лицензия', 'Отозвать лицензию — удалить компанию со всеми данными')}</tr></thead>
          <tbody>${orgRows || '<tr><td colspan="4" class="muted">Компаний пока нет.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="section">
        <h2>Пользователи</h2>
        <div class="scroll"><table class="rt">
          <thead><tr>${thT('Пользователь', 'Имя и email')}${thT('Регистрация', 'Дата регистрации')}${thT('Компаний', 'Владелец / участник (сколько компаний)')}${thT('Действие', 'Полное удаление пользователя из системы')}</tr></thead>
          <tbody>${userRows || '<tr><td colspan="4" class="muted">Пользователей нет.</td></tr>'}</tbody>
        </table></div>
      </div>

      ${resetSection}
    </div>`,
  });
}

// Кнопка-форма (POST + CSRF) для одиночных действий. action уже с префиксом base.
function formBtn(csrf, action, label, cls = 'mini btn-sm', confirm) {
  const onsubmit = confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : '';
  return `<form method="post" action="${action}" style="display:inline-block;margin:0 0 0 6px"${onsubmit}>${csrfField(csrf)}<button class="btn ${cls}" type="submit">${esc(label)}</button></form>`;
}
const okBox = (m) => `<div class="ok">${esc(m)}</div>`;
const okOrWarn = (m) => `<div class="warn">${esc(m)}</div>`;

// Блок созданной ссылки-приглашения: кликабельная ссылка + поле для копирования.
function inviteCreatedBox({ email, url }) {
  return `<div class="ok">
    Ссылка-приглашение для <b>${esc(email)}</b> создана (действует 7 дней). Отправьте её человеку — принять сможет только этот email.
    <div style="margin-top:8px"><a href="${esc(url)}" style="font-weight:600;word-break:break-all">${esc(url)}</a></div>
    <input class="linkbox" style="width:100%;margin-top:8px" readonly value="${esc(url)}" onclick="this.select()" aria-label="Ссылка-приглашение">
  </div>`;
}

// ── Отчёты ───────────────────────────────────────────────────────────────────
const nf = (n) => (n == null ? '' : Number(n).toLocaleString('ru-RU'));
const ST = { 'разрыв до поставки': 'st-gap', 'нет остатка': 'st-gap', 'риск разрыва': 'st-risk', 'ок': 'st-ok', 'неликвид': 'st-dead', 'нет данных': 'st-dead' };
const statusBadge = (s) => `<span class="badge ${ST[s] || 'st-dead'}">${esc(s)}</span>`;

// Глоссарий подсорта — работает и на телефоне (в отличие от hover-подсказок).
function podsortGlossary() {
  const dt = (t, d) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`;
  return `<details style="margin-top:14px"><summary>❓ Пояснения к параметрам, колонкам и статусам</summary>
    <div style="padding:4px 2px 8px">
      <h3 style="margin:8px 0 2px;font-size:14px">Параметры</h3>
      <dl class="gloss">
        ${dt('Артикулы в работе', 'Номера моделей (первые цифры артикула WB), по которым считаем. Пусто — значения по умолчанию сервиса.')}
        ${dt('Окно скорости, дн', 'За сколько последних дней берём среднюю скорость продаж (шт/день) по каждому размеру на каждом складе.')}
        ${dt('Лид мин / макс, дн', 'Срок «заказ → товар на FF-складе» (сборка + доставка), минимум и максимум. Горизонт заказа = Лид макс + Запас.')}
        ${dt('Запас, дн', 'Страховой запас в днях сверх лид-тайма — на сколько дней продаж хотим покрыть.')}
        ${dt('Завоз/размер', 'Сколько штук завозить «на пробу» на склад, где этого размера ещё не было, — на каждый размер.')}
        ${dt('История, дн', 'За сколько последних дней берём заказы для анализа присутствия товара и скорости.')}
      </dl>
      <h3 style="margin:12px 0 2px;font-size:14px">Колонки</h3>
      <dl class="gloss">
        ${dt('Арт / Цвет / Разм', 'Артикул (модель), вариант/цвет, размер (techSize).')}
        ${dt('Остаток', 'Текущий остаток этого размера на этом складе (FBS).')}
        ${dt('/дн', 'Средняя скорость продаж, шт/день, за окно скорости.')}
        ${dt('Дней до 0', 'На сколько дней хватит остатка при текущей скорости (∞ — продаж нет).')}
        ${dt('Подсорт', 'Рекомендация к заказу = скорость × (Лид макс + Запас) − остаток. Округление вверх, минимум 0.')}
      </dl>
      <h3 style="margin:12px 0 2px;font-size:14px">Статусы</h3>
      <dl class="gloss">
        ${dt('разрыв до поставки', 'Остаток кончится раньше минимального лид-тайма — подсорт может не успеть доехать.')}
        ${dt('риск разрыва', 'Может кончиться до максимального лид-тайма.')}
        ${dt('нет остатка', 'На складе 0, но продажи есть.')}
        ${dt('неликвид', 'Остаток есть, продаж нет.')}
        ${dt('ок', 'Запаса хватает.')}
      </dl>
      <h3 style="margin:12px 0 2px;font-size:14px">Таблицы</h3>
      <dl class="gloss">
        ${dt('Сводная', 'Строка = артикул × цвет × размер; столбцы = склады; значение = сколько заказать на этот склад; Итого — сумма по строке.')}
        ${dt('Пробный завоз', 'Новинка — карточки ещё не было ни на одном FF-складе; докладка — есть на других складах, но не на этом.')}
      </dl>
    </div>
  </details>`;
}

export function reportsPage(p) {
  const { user, csrf, base = '', org, role, active } = p;
  const u = (path) => base + path;
  const owner = role === 'owner';
  const cabLine = active
    ? `<p class="kv">Кабинет: <b>${esc(active.name)}</b> <span class="badge on">подключён</span></p>`
    : owner
      ? `<div class="warn">Кабинет ещё не настроен. <a href="${u(`/org/${org.id}`)}">Настроить кабинет</a>.</div>`
      : `<div class="warn">Кабинет ещё не настроен владельцем — отчёты пока недоступны.</div>`;
  const card = (href, title, desc, ready) => ready
    ? `<a class="tile" href="${u(href)}" style="display:block"><h3>${esc(title)}</h3><p>${esc(desc)} →</p></a>`
    : `<div class="tile soon"><h3>${esc(title)} <span class="pill">скоро</span></h3><p>${esc(desc)}</p></div>`;
  const crumb = owner ? `<a href="${u(`/org/${org.id}`)}">← ${esc(org.name)}</a>` : `<a href="${u('/')}">← Компании</a>`;
  return layout({
    title: `Отчёты — ${org.name}`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs">${crumb}</div>
      <h1>${esc(org.name)} — отчёты</h1>
      ${cabLine}
      <div class="grid" style="margin-top:14px">
        ${card(`/org/${org.id}/reports/podsort`, 'Подсорт', 'Рекомендации к заказу по складам и размерам + пробный завоз', !!active)}
        ${card(`/org/${org.id}/reports/stock`, 'Остатки', 'Остатки FBS по складам и по артикулам/цветам', !!active)}
        ${card(`/org/${org.id}/reports/movement`, 'Движение заказов', 'Принято на фулфилмент и передано в доставку — по дням и складам, шт и ₽', !!active)}
      </div>
      <p style="margin-top:16px"><a class="dl" href="${u(`/org/${org.id}/reports/archive`)}">🗂 Архив отчётов</a></p>
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

  // Форма параметров (у каждого поля — всплывающая подсказка title + краткий хинт).
  const f = form;
  const field = (name, label, val, hint, title) => `<div><label for="${name}" title="${esc(title)}">${esc(label)}${hint ? ` <span class="muted">${esc(hint)}</span>` : ''}</label>
    <input id="${name}" name="${name}" type="number" min="1" value="${esc(String(val))}" title="${esc(title)}" style="width:120px"></div>`;
  const formSection = `
    <div class="section">
      <h2>Параметры расчёта</h2>
      <label for="articles" title="Номера моделей (первые цифры артикула WB), которые сейчас в работе. Отчёт и пробный завоз считаются только по ним. Пусто — берутся значения по умолчанию сервиса.">Артикулы в работе <span class="muted">(номера через запятую; пусто — по умолчанию)</span></label>
      <form method="post" action="${u(`/org/${org.id}/reports/podsort/refresh`)}">
        ${csrfField(csrf)}
        <input id="articles" name="articles" type="text" value="${esc(f.articles)}" placeholder="002, 003, 023 …" title="Номера моделей через запятую. Только по ним считается подсорт и завоз.">
        <div class="row-form" style="margin-top:12px;gap:14px">
          ${field('velocityDays', 'Окно скорости, дн', f.velocityDays, '', 'За сколько последних дней считаем среднюю скорость продаж (шт/день) по каждому размеру на каждом складе.')}
          ${field('leadMin', 'Лид мин, дн', f.leadMin, '', 'Минимальный срок «заказ → товар на FF-складе» (сборка + доставка). Если запас кончится раньше — статус «разрыв до поставки».')}
          ${field('leadMax', 'Лид макс, дн', f.leadMax, '', 'Максимальный срок поставки на FF-склад. Горизонт заказа = Лид макс + Запас.')}
          ${field('cover', 'Запас, дн', f.cover, '', 'Страховой запас в днях сверх лид-тайма — на сколько дней продаж хотим покрыть. Горизонт заказа = Лид макс + Запас.')}
          ${field('seedMin', 'Пробный завоз/размер', f.seedMin, '', 'Сколько штук завозить «на пробу» на склад, где этого размера ещё не было (новинка/докладка), — на каждый размер.')}
          ${field('historyDays', 'История, дн', f.historyDays, '', 'За сколько последних дней берём заказы для анализа присутствия товара и скорости.')}
        </div>
        <button class="btn" type="submit" style="max-width:280px;margin-top:18px"${running ? ' disabled' : ''}>${running ? 'Идёт пересчёт…' : 'Обновить данные'}</button>
      </form>
      ${podsortGlossary()}
    </div>`;

  // Результаты последнего снимка (общий рендер, переиспользуется в архиве).
  const results = latest?.data
    ? podsortResults(latest.data, {
      downloadHref: (k) => u(`/org/${org.id}/reports/podsort/download/${k}`),
      whenLabel: latest.createdAt ? String(latest.createdAt).slice(0, 16).replace('T', ' ') + ' UTC' : '',
    })
    : `<div class="section"><p class="muted">Данных пока нет — нажмите «Обновить данные», чтобы рассчитать подсорт на токене активного кабинета.</p></div>`;

  return layout({
    title: `Подсорт — ${org.name}`, user, csrf, base, head: meta,
    body: `<div class="wrap">${back}
      <h1>Подсорт <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p class="kv">Кабинет: <b>${esc(active.name)}</b>. Расчёт по FF-складам и размерам; лид-тайм и запас задаются ниже. <a href="${u(`/org/${org.id}/reports/archive`)}">🗂 Архив запусков</a></p>
      ${statusBox}
      ${formSection}
      ${results}
    </div>`,
  });
}

const reportRu = (r) => ({ podsort: 'Подсорт', stock: 'Остатки', movement: 'Движение заказов' }[r] || r);

// Рендер результатов подсорта из снимка (переиспользуется на странице отчёта и в архиве).
// downloadHref(kind) → URL выгрузки; whenLabel — подпись «обновлено …».
function podsortResults(s, { downloadHref, whenLabel }) {
  const t = s.totals || {};
  const tiles = [
    ['Подсорт, шт', t.reorderUnits], ['Строк в риске', t.riskRows],
    ['Пробный завоз, шт', t.seedUnits], ['Складов', t.warehouses], ['Номенклатура', t.nomenclature],
  ].map(([l, n]) => `<div class="tilek"><div class="n">${nf(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

  const cols = s.warehouseList || [];
  const pivotHead = `<tr>${thT('Арт', 'Номер артикула (модель)')}${thT('Цвет', 'Вариант/цвет исполнения')}${thT('Разм', 'Размер (techSize карточки)')}${cols.map((c) => thT(c, `Сколько заказать на склад «${c}»`, 'num')).join('')}${thT('Итого', 'Сумма подсорта по строке (все склады)', 'num')}</tr>`;
  const pivotRows = (s.pivot || []).map((r) => `<tr><td>${esc(r.articleNum)}</td><td class="tl">${esc(r.variant)}</td><td>${esc(r.techSize)}</td>${cols.map((c) => `<td class="num">${r.byWarehouse?.[c] ? nf(r.byWarehouse[c]) : ''}</td>`).join('')}<td class="num"><b>${nf(r.total)}</b></td></tr>`).join('');
  const pivotTable = pivotRows
    ? `<div class="scroll"><table class="rt"><thead>${pivotHead}</thead><tbody>${pivotRows}</tbody></table></div>`
    : '<p class="muted">Подсорт не требуется (0 строк).</p>';

  const whBlocks = (s.warehouses || []).filter((w) => w.rows?.length).map((w) => `
    <details><summary>${esc(w.name)} — остаток ${nf(w.stockUnits)} · подсорт ${nf(w.reorderUnits)} шт · строк ${w.rows.length}</summary>
      <div class="scroll"><table class="rt">
        <thead><tr>${thT('Арт', 'Номер артикула (модель)')}${thT('Цвет', 'Вариант/цвет')}${thT('Разм', 'Размер')}${thT('Остаток', 'Текущий остаток этого размера на этом складе (FBS)', 'num')}${thT('/дн', 'Средняя скорость продаж, шт/день, за окно скорости', 'num')}${thT('Дней до 0', 'На сколько дней хватит остатка при текущей скорости (∞ — продаж нет)', 'num')}${thT('Подсорт', 'Рекомендация к заказу = скорость × горизонт − остаток (округление вверх, минимум 0)', 'num')}${thT('Статус', 'Оценка риска нехватки')}</tr></thead>
        <tbody>${w.rows.map((r) => `<tr><td>${esc(r.articleNum)}</td><td class="tl">${esc(r.variant)}</td><td>${esc(r.techSize)}</td><td class="num">${nf(r.stock)}</td><td class="num">${esc(String(r.perDay))}</td><td class="num">${r.daysToZero == null ? '∞' : esc(String(r.daysToZero))}</td><td class="num"><b>${nf(r.reorderQty)}</b></td><td class="tl">${statusBadge(r.status)}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>`).join('');

  const seedRows = (s.seedGrid || []).map((r) => `<tr><td>${esc(r.articleNum)}</td><td class="tl">${esc(r.variant)}</td><td>${esc(r.techSize)}</td><td><span class="badge ${r.kind === 'новинка' ? 'st-ok' : 'st-risk'}">${esc(r.kind)}</span></td><td class="num"><b>${nf(r.seedTotal)}</b></td></tr>`).join('');
  const seedBlock = seedRows
    ? `<details><summary>Пробный завоз — ${nf(t.seedRows)} строк (${nf(t.seedNovelty)} новинок + ${nf(t.seedRefill)} докладок) = ${nf(t.seedUnits)} шт</summary>
        <div class="scroll"><table class="rt"><thead><tr>${thT('Арт', 'Номер артикула')}${thT('Цвет', 'Вариант/цвет')}${thT('Разм', 'Размер')}${thT('Тип', 'Новинка — карточки ещё не было ни на одном FF-складе; докладка — есть на других складах, но не на этом')}${thT('Кол-во', 'Всего штук к пробному завозу по всем складам', 'num')}</tr></thead><tbody>${seedRows}</tbody></table></div></details>`
    : '';

  return `<div class="section">
      <h2>Результат ${whenLabel ? `<span class="muted" style="font-size:13px;font-weight:400">${esc(whenLabel)}</span>` : ''}</h2>
      <div class="tiles">${tiles}</div>
      <div style="margin-bottom:6px">
        <a class="dl" href="${downloadHref('xlsx')}">⬇ Excel</a>
        <a class="dl" href="${downloadHref('html')}">⬇ HTML-дашборд</a>
        <a class="dl" href="${downloadHref('json')}">⬇ JSON</a>
      </div>
      <h2>Сводная: подсорт по размерам × склад</h2>
      ${pivotTable}
      <h2 style="margin-top:20px">Детально по складам</h2>
      ${whBlocks || '<p class="muted">Нет строк.</p>'}
      ${seedBlock}
    </div>`;
}

// Рендер результатов остатков из снимка (страница отчёта и архив).
function stockResults(s, { downloadHref, whenLabel }) {
  const t = s.totals || {};
  const tiles = [
    ['Всего, шт', t.grandTotal], ['Активных складов', t.activeWarehouses], ['Артикул+цвет', t.articleCount],
  ].map(([l, n]) => `<div class="tilek"><div class="n">${nf(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

  const whRows = (s.warehouses || []).map((w) => `<tr><td class="tl">${esc(w.name)}</td><td class="num">${nf(w.totalQuantity)}</td><td class="num">${nf(w.skuInStock)}</td></tr>`).join('');
  const whTable = `<div class="scroll"><table class="rt"><thead><tr>${thT('Фулфилмент', 'Склад продавца (FBS)')}${thT('Остаток, шт', 'Всего единиц на складе', 'num')}${thT('Позиций (SKU)', 'Сколько штрихкодов в наличии', 'num')}</tr></thead><tbody>${whRows}</tbody></table></div>`;

  const cols = s.warehouseList || [];
  const head = `<tr>${thT('Арт', 'Номер артикула')}${thT('Цвет', 'Вариант/цвет')}${cols.map((c) => thT(c, `Остаток на «${c}»`, 'num')).join('')}${thT('Итого', 'Всего по всем складам', 'num')}</tr>`;
  const rows = (s.articles || []).map((a) => `<tr><td>${esc(a.articleNum)}</td><td class="tl">${esc(a.variant)}</td>${cols.map((c) => `<td class="num">${a.byWarehouse?.[c] ? nf(a.byWarehouse[c]) : ''}</td>`).join('')}<td class="num"><b>${nf(a.total)}</b></td></tr>`).join('');
  const matrix = rows ? `<div class="scroll"><table class="rt"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Нет остатков.</p>';

  return `<div class="section">
      <h2>Результат ${whenLabel ? `<span class="muted" style="font-size:13px;font-weight:400">${esc(whenLabel)}</span>` : ''}</h2>
      <div class="tiles">${tiles}</div>
      <div style="margin-bottom:6px"><a class="dl" href="${downloadHref('xlsx')}">⬇ Excel</a> <a class="dl" href="${downloadHref('json')}">⬇ JSON</a></div>
      <h2>По фулфилментам</h2>
      ${whTable}
      <h2 style="margin-top:20px">Остаток по артикул+цвет × склад</h2>
      <p class="kv" style="margin:0 0 8px">Размеры внутри карточки (nmID) объединены в одну цифру.</p>
      ${matrix}
    </div>`;
}

export function stockPage(p) {
  const { user, csrf, base = '', org, role, active, latest, snapshots = [], selected, job } = p;
  const u = (path) => base + path;
  const back = `<div class="crumbs"><a href="${u(`/org/${org.id}/reports`)}">← Отчёты</a></div>`;
  if (!active) {
    return layout({ title: `Остатки — ${org.name}`, user, csrf, base,
      body: `<div class="wrap">${back}<h1>Остатки</h1><div class="warn">Нет активного кабинета с токеном. <a href="${u(`/org/${org.id}`)}">Настройте кабинет</a>.</div></div>` });
  }
  const running = job && job.state === 'running';
  const head = running ? '<meta http-equiv="refresh" content="4">' : '';
  let statusBox = '';
  if (running) statusBox = `<div class="running">⏳ Получаю остатки на токене кабинета «${esc(active.name)}»… ${esc(job.log || '')}<br><span class="muted">Страница обновится сама.</span></div>`;
  else if (job && job.state === 'error') statusBox = `<div class="err" style="white-space:pre-wrap">Ошибка: ${esc(job.error || '')}</div>`;
  else if (job && job.state === 'done') statusBox = okBox('Готово.');

  // Показываем выбранный снимок из архива (на дату) либо последний.
  const view = selected || latest;
  const isArchived = !!selected;
  const whenLabel = view?.createdAt ? String(view.createdAt).slice(0, 16).replace('T', ' ') + ' UTC' : '';
  const dlHref = isArchived
    ? (k) => u(`/org/${org.id}/reports/archive/${selected.id}/download/${k}`)
    : (k) => u(`/org/${org.id}/reports/stock/download/${k}`);
  const results = view?.data
    ? `${isArchived ? `<div class="section" style="padding-bottom:0"><div class="warn" style="margin:0">📅 Снимок остатков на <b>${esc(whenLabel)}</b> (из архива). <a href="${u(`/org/${org.id}/reports/stock`)}">← к текущему</a></div></div>` : ''}
       ${stockResults(view.data, { downloadHref: dlHref, whenLabel })}`
    : `<div class="section"><p class="muted">Данных пока нет — нажмите «Обновить данные».</p></div>`;

  // Выпадающий выбор даты снимка (из накопленного архива остатков).
  const curId = latest?.id;
  const dateOpts = snapshots.map((s) => {
    const label = String(s.createdAt || '').slice(0, 16).replace('T', ' ') + ' UTC' + (s.id === curId ? ' — текущий' : '') + (s.authorId ? '' : ' · авто');
    const sel = (isArchived ? s.id === selected.id : s.id === curId) ? ' selected' : '';
    return `<option value="${s.id}"${sel}>${esc(label)}</option>`;
  }).join('');
  const datePicker = snapshots.length > 1
    ? `<div class="section"><label class="kv" style="display:block;margin-bottom:6px" title="Показать остатки на выбранную сохранённую дату (из архива снимков)">Снимок на дату</label>
       <form method="get" action="${u(`/org/${org.id}/reports/stock`)}"><select name="run" style="max-width:340px" onchange="this.form.submit()">${dateOpts}</select> <noscript><button class="btn" type="submit" style="max-width:140px;display:inline-block">Показать</button></noscript></form></div>`
    : '';

  return layout({
    title: `Остатки — ${org.name}`, user, csrf, base, head,
    body: `<div class="wrap">${back}
      <h1>Остатки <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p class="kv">Кабинет: <b>${esc(active.name)}</b>. Текущий остаток FBS по складам и артикулам/цветам. Снимок сохраняется автоматически раз в сутки. <a href="${u(`/org/${org.id}/reports/archive`)}">🗂 Архив запусков</a></p>
      ${statusBox}
      <div class="section"><form method="post" action="${u(`/org/${org.id}/reports/stock/refresh`)}">${csrfField(csrf)}<button class="btn" type="submit" style="max-width:280px"${running ? ' disabled' : ''}>${running ? 'Идёт обновление…' : 'Обновить данные'}</button></form></div>
      ${datePicker}
      ${results}
    </div>`,
  });
}

// ── Движение заказов (принято / передано / разница) ─────────────────────────
const MV_PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#9c755f', '#ff9da7', '#bab0ac'];
const MV_FOCUS = { accepted: 'Принято', delivered: 'Передано', diff: 'Разница' };

// Нормализация состояния просмотра (из query) с дефолтами.
export function movementView(q = {}) {
  const one = (v, allowed, def) => (allowed.includes(String(v)) ? String(v) : def);
  return {
    focus: one(q.focus, ['accepted', 'delivered', 'diff'], 'delivered'),
    unit: one(q.unit, ['count', 'money'], 'count'),
    gran: one(q.gran, ['day', 'week'], 'day'),
    ov: one(q.ov, ['none', 'cum', 'ma'], 'none'),
    cmp: String(q.cmp) === '1' ? '1' : '0',
  };
}

// ISO-неделя из 'YYYY-MM-DD' → ключ 'YYYY-Wnn' + подпись.
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;            // Пн=0
  d.setUTCDate(d.getUTCDate() - day + 3);         // четверг этой недели
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return { key: `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, label: `нед ${week}` };
}

// Компактная подпись оси.
const mvAxis = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + 'м';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace('.', ',') + 'к';
  return String(Math.round(v));
};
const mvVal = (v, money) => (money ? nf(Math.round(v)) + ' ₽' : nf(v));

// Значение метрики для дня d и фулфилмента name (name=null → всего).
function mvCell(d, view, name) {
  const u = view.unit;
  const pick = (blk) => (name ? ((blk?.byFulfillment?.[name] || {})[u] || 0) : (blk?.[u] || 0));
  if (view.focus === 'accepted') return pick(d.accepted);
  if (view.focus === 'delivered') return pick(d.delivered);
  return pick(d.delivered) - pick(d.accepted);
}

// Свернуть дни в корзины (день/неделя) для набора фулфилментов.
function mvBuckets(entries, view, ffShown) {
  if (view.gran === 'day') {
    return entries.map((d) => ({
      label: d.date.slice(5), key: d.date,
      byFf: Object.fromEntries(ffShown.map((n) => [n, mvCell(d, view, n)])),
      total: mvCell(d, view, null),
    }));
  }
  const map = new Map();
  for (const d of entries) {
    const w = isoWeek(d.date);
    if (!map.has(w.key)) map.set(w.key, { label: w.label, key: w.key, byFf: Object.fromEntries(ffShown.map((n) => [n, 0])), total: 0 });
    const b = map.get(w.key);
    for (const n of ffShown) b.byFf[n] += mvCell(d, view, n);
    b.total += mvCell(d, view, null);
  }
  return [...map.values()];
}

// Оверлей на серию значений (нарастающий итог / скользящее среднее).
function mvOverlay(values, ov, win) {
  if (ov === 'cum') { let s = 0; return values.map((v) => (s += v)); }
  if (ov === 'ma') return values.map((_, i) => { const a = values.slice(Math.max(0, i - win + 1), i + 1); return a.reduce((x, y) => x + y, 0) / a.length; });
  return values;
}

// Многолинейный SVG-график (тема через var()). lines: [{name,color,values,bold}].
function mvChart(buckets, lines) {
  const W = 760, H = 280, pl = 46, pr = 14, pt = 12, pb = 40;
  const iw = W - pl - pr, ih = H - pt - pb, n = buckets.length;
  let max = 0, min = 0;
  for (const ln of lines) for (const v of ln.values) { if (v > max) max = v; if (v < min) min = v; }
  if (max === min) max = min + 1;
  const x = (i) => pl + (n <= 1 ? iw / 2 : iw * i / (n - 1));
  const y = (v) => pt + ih * (1 - (v - min) / (max - min));
  let grid = '';
  for (let t = 0; t <= 4; t++) { const val = min + (max - min) * t / 4, yy = y(val); grid += `<line x1="${pl}" y1="${yy.toFixed(1)}" x2="${W - pr}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="${pl - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(mvAxis(val))}</text>`; }
  const zero = min < 0 ? `<line x1="${pl}" y1="${y(0).toFixed(1)}" x2="${W - pr}" y2="${y(0).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>` : '';
  const step = Math.max(1, Math.ceil(n / 8)); let xlab = '';
  buckets.forEach((b, i) => { if (i % step === 0 || i === n - 1) xlab += `<text x="${x(i).toFixed(1)}" y="${H - pb + 16}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(b.label)}</text>`; });
  let paths = '';
  for (const ln of lines) {
    if (n === 1) { paths += `<circle cx="${x(0).toFixed(1)}" cy="${y(ln.values[0]).toFixed(1)}" r="3" fill="${ln.color}"/>`; continue; }
    const pts = ln.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    paths += `<polyline points="${pts}" fill="none" stroke="${ln.color}" stroke-width="${ln.bold ? 2.6 : 1.6}" stroke-linejoin="round" stroke-linecap="round"${ln.bold ? '' : ' opacity="0.92"'}/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="mv-chart" preserveAspectRatio="xMidYMid meet" role="img" aria-label="График движения заказов">${grid}${zero}${paths}${xlab}</svg>`;
}

// Рендер результатов движения (страница отчёта и архив).
// nav(patch)→URL строит тумблеры (если null — статичный вид, как в архиве).
function movementResults(snap, { view, nav = null, downloadHref, whenLabel }) {
  const N = snap.days || 14;
  const series = snap.series || [];
  const display = series.slice(-N);
  const prev = series.length > N ? series.slice(Math.max(0, series.length - 2 * N), series.length - N) : [];
  const ffAll = snap.fulfillments || [];
  const money = view.unit === 'money';

  // Сводные плитки за период (всегда обе метрики — для контекста).
  const sumC = (k) => display.reduce((s, d) => s + (d[k]?.count || 0), 0);
  const sumM = (k) => display.reduce((s, d) => s + (d[k]?.money || 0), 0);
  const accC = sumC('accepted'), delC = sumC('delivered');
  const tiles = [
    ['Принято, шт', accC], ['Передано, шт', delC], ['Разница, шт', delC - accC], ['Передано, ₽', Math.round(sumM('delivered'))],
  ].map(([l, v]) => `<div class="tilek"><div class="n">${nf(v)}</div><div class="l">${esc(l)}</div></div>`).join('');

  // Тумблеры.
  const seg = (lab, key, opts) => (nav ? `<div class="mv-seg"><span class="lab">${esc(lab)}</span>${opts.map((o) => `<a class="mv-chip${view[key] === o.v ? ' on' : ''}" href="${nav({ [key]: o.v })}">${esc(o.label)}</a>`).join('')}</div>` : '');
  const toolbar = nav ? `<div class="mv-bar">
    ${seg('Показатель', 'focus', [{ v: 'accepted', label: 'Принято' }, { v: 'delivered', label: 'Передано' }, { v: 'diff', label: 'Разница' }])}
    ${seg('Единица', 'unit', [{ v: 'count', label: 'шт' }, { v: 'money', label: '₽' }])}
    ${seg('Разбивка', 'gran', [{ v: 'day', label: 'День' }, { v: 'week', label: 'Неделя' }])}
    ${seg('График', 'ov', [{ v: 'none', label: '—' }, { v: 'cum', label: 'Нарастающий' }, { v: 'ma', label: 'Скользящее' }])}
    ${seg('Сравнение', 'cmp', [{ v: '1', label: 'вкл' }, { v: '0', label: 'выкл' }])}
  </div>` : '';

  // Корзины + линии графика.
  const buckets = mvBuckets(display, view, ffAll);
  const win = view.gran === 'day' ? 7 : 3;
  const lines = ffAll.map((n, i) => ({ name: n, color: MV_PALETTE[i % MV_PALETTE.length], bold: false, values: mvOverlay(buckets.map((b) => b.byFf[n] || 0), view.ov, win) }));
  const totalLine = { name: 'Итого', color: 'var(--ink)', bold: true, values: mvOverlay(buckets.map((b) => b.total), view.ov, win) };
  const chartLines = ffAll.length > 1 ? [...lines, totalLine] : lines;
  const legend = `<div class="mv-legend">${chartLines.map((ln) => `<span><i style="background:${ln.color}"></i>${esc(ln.name)}</span>`).join('')}</div>`;
  const chart = buckets.length ? `${mvChart(buckets, chartLines)}${legend}` : '<p class="muted">Нет данных за период.</p>';

  // Таблица корзина × фулфилмент.
  const head = `<tr>${thT(view.gran === 'day' ? 'День' : 'Неделя', 'Период')}${ffAll.map((n) => thT(n, `${MV_FOCUS[view.focus]} — ${n}`, 'num')).join('')}${thT('Итого', 'Сумма по строке', 'num')}</tr>`;
  const rows = buckets.map((b) => `<tr><td class="tl">${esc(b.label)}</td>${ffAll.map((n) => `<td class="num">${b.byFf[n] ? mvVal(b.byFf[n], money) : ''}</td>`).join('')}<td class="num"><b>${mvVal(b.total, money)}</b></td></tr>`).join('');
  const colTotals = ffAll.map((n) => buckets.reduce((s, b) => s + (b.byFf[n] || 0), 0));
  const grand = buckets.reduce((s, b) => s + b.total, 0);
  const footer = `<tr style="border-top:2px solid var(--line)"><td class="tl"><b>Итого</b></td>${colTotals.map((v) => `<td class="num"><b>${mvVal(v, money)}</b></td>`).join('')}<td class="num"><b>${mvVal(grand, money)}</b></td></tr>`;
  const table = buckets.length ? `<div class="scroll"><table class="rt"><thead>${head}</thead><tbody>${rows}${footer}</tbody></table></div>` : '';

  // Сравнение с прошлым периодом.
  let compare = '';
  if (view.cmp === '1') {
    if (!prev.length) compare = '<p class="muted">Недостаточно истории для сравнения с прошлым периодом.</p>';
    else {
      const curBy = (n) => display.reduce((s, d) => s + mvCell(d, view, n), 0);
      const prvBy = (n) => prev.reduce((s, d) => s + mvCell(d, view, n), 0);
      const pct = (c, p) => (p ? `${c - p >= 0 ? '+' : ''}${Math.round((c - p) / Math.abs(p) * 100)}%` : (c ? '—' : '0%'));
      const line = (label, c, p) => `<tr><td class="tl">${esc(label)}</td><td class="num">${mvVal(c, money)}</td><td class="num">${mvVal(p, money)}</td><td class="num">${c - p >= 0 ? '+' : ''}${mvVal(c - p, money)}</td><td class="num">${esc(pct(c, p))}</td></tr>`;
      const body = ffAll.map((n) => line(n, curBy(n), prvBy(n))).join('') + `<tr style="border-top:2px solid var(--line)"><td class="tl"><b>Итого</b></td><td class="num"><b>${mvVal(curBy(null), money)}</b></td><td class="num"><b>${mvVal(prvBy(null), money)}</b></td><td class="num"><b>${curBy(null) - prvBy(null) >= 0 ? '+' : ''}${mvVal(curBy(null) - prvBy(null), money)}</b></td><td class="num"><b>${esc(pct(curBy(null), prvBy(null)))}</b></td></tr>`;
      compare = `<h2 style="margin-top:20px">Сравнение с прошлым периодом</h2>
        <p class="kv" style="margin:0 0 8px">Показатель «${esc(MV_FOCUS[view.focus])}» за ${N} дн против предыдущих ${N} дн.</p>
        <div class="scroll"><table class="rt"><thead><tr>${thT('Фулфилмент', 'Склад')}${thT('Текущий', 'Текущий период', 'num')}${thT('Прошлый', 'Предыдущий период', 'num')}${thT('Δ', 'Разница', 'num')}${thT('%', 'Изменение', 'num')}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
  }

  const artLine = (snap.articles && snap.articles.length) ? ` · артикулы: ${esc(snap.articles.join(', '))}` : '';
  return `<div class="section">
      <h2>${esc(MV_FOCUS[view.focus])}${view.unit === 'money' ? ', ₽' : ', шт'} за ${N} дн ${whenLabel ? `<span class="muted" style="font-size:13px;font-weight:400">${esc(whenLabel)}</span>` : ''}</h2>
      <p class="kv" style="margin:0 0 8px">Период по МСК (${esc(snap.tz || '+03:00')})${artLine}. «Принято» — по дате создания задания, «Передано» — по дате закрытия поставки.</p>
      <div class="tiles">${tiles}</div>
      ${toolbar}
      <div style="margin-bottom:6px"><a class="dl" href="${downloadHref('xlsx')}">⬇ Excel</a> <a class="dl" href="${downloadHref('json')}">⬇ JSON</a></div>
      ${chart}
      ${table}
      ${compare}
    </div>`;
}

export function movementPage(p) {
  const { user, csrf, base = '', org, role, active, latest, job, view, form } = p;
  const u = (path) => base + path;
  const back = `<div class="crumbs"><a href="${u(`/org/${org.id}/reports`)}">← Отчёты</a></div>`;
  if (!active) {
    return layout({ title: `Движение заказов — ${org.name}`, user, csrf, base,
      body: `<div class="wrap">${back}<h1>Движение заказов</h1><div class="warn">Нет активного кабинета с токеном. <a href="${u(`/org/${org.id}`)}">Настройте кабинет</a>.</div></div>` });
  }
  const running = job && job.state === 'running';
  const head = running ? '<meta http-equiv="refresh" content="4">' : '';
  let statusBox = '';
  if (running) statusBox = `<div class="running">⏳ Считаю движение заказов на токене кабинета «${esc(active.name)}»… ${esc(job.log || '')}<br><span class="muted">Страница обновится сама. Может занять 1–3 минуты.</span></div>`;
  else if (job && job.state === 'error') statusBox = `<div class="err" style="white-space:pre-wrap">Ошибка: ${esc(job.error || '')}</div>`;
  else if (job && job.state === 'done') statusBox = okBox('Готово.');

  // Форма периода/артикулов (перезапуск — новый снимок).
  const f = form;
  const formSection = `<div class="section">
    <h2>Параметры</h2>
    <form method="post" action="${u(`/org/${org.id}/reports/movement/refresh`)}">
      ${csrfField(csrf)}
      <div class="row-form" style="gap:14px;align-items:flex-end">
        <div><label for="days" title="За сколько последних дней собрать движение. Для сравнения тянется вдвое больший период (в пределах 3 месяцев — лимит WB).">Период, дней</label>
          <select id="days" name="days" style="width:130px">${[7, 14, 30, 45].map((n) => `<option value="${n}"${Number(f.days) === n ? ' selected' : ''}>${n} дней</option>`).join('')}</select></div>
        <div style="flex:1;min-width:220px"><label for="mvart" title="Фильтр по номерам моделей (первые цифры артикула). Пусто — все артикулы.">Артикулы <span class="muted">(через запятую; пусто — все)</span></label>
          <input id="mvart" name="articles" type="text" value="${esc(f.articles || '')}" placeholder="018, 020 …" style="width:100%"></div>
      </div>
      <button class="btn" type="submit" style="max-width:280px;margin-top:16px"${running ? ' disabled' : ''}>${running ? 'Идёт сбор…' : 'Обновить данные'}</button>
    </form></div>`;

  const nav = (patch) => {
    const v = { ...view, ...patch };
    return u(`/org/${org.id}/reports/movement?focus=${v.focus}&unit=${v.unit}&gran=${v.gran}&ov=${v.ov}&cmp=${v.cmp}`);
  };
  const results = latest?.data
    ? movementResults(latest.data, { view, nav, downloadHref: (k) => u(`/org/${org.id}/reports/movement/download/${k}`), whenLabel: latest.createdAt ? String(latest.createdAt).slice(0, 16).replace('T', ' ') + ' UTC' : '' })
    : `<div class="section"><p class="muted">Данных пока нет — задайте период и нажмите «Обновить данные».</p></div>`;

  return layout({
    title: `Движение заказов — ${org.name}`, user, csrf, base, head,
    body: `<div class="wrap">${back}
      <h1>Движение заказов <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p class="kv">Кабинет: <b>${esc(active.name)}</b>. Принято на фулфилмент и передано в доставку — по дням и складам, в штуках и рублях. <a href="${u(`/org/${org.id}/reports/archive`)}">🗂 Архив запусков</a></p>
      ${statusBox}
      ${formSection}
      ${results}
    </div>`,
  });
}

// ── Архив отчётов компании: список запусков ─────────────────────────────────
export function archivePage({ user, csrf, base = '', org, role, runs }) {
  const u = (p) => base + p;
  const dt = (v) => esc(String(v || '').slice(0, 16).replace('T', ' ')) + ' UTC';
  const summ = (r) => {
    const sm = r.summary || {};
    if (r.report === 'stock') return `остаток ${nf(sm.grandTotal)} шт · складов ${nf(sm.activeWarehouses)} · арт+цвет ${nf(sm.articleCount)}`;
    if (r.report === 'movement') return `принято ${nf(sm.acceptedTotal)} · передано ${nf(sm.deliveredTotal)} · Δ ${sm.diffTotal >= 0 ? '+' : ''}${nf(sm.diffTotal)} · ${nf(sm.deliveredMoney)} ₽ (${nf(sm.days)} дн)`;
    return `подсорт ${nf(sm.reorderUnits)} · риск ${nf(sm.riskRows)} · завоз ${nf(sm.seedUnits)}${(sm.articles && sm.articles.length) ? ` · арт: ${esc(sm.articles.join(', '))}` : ''}`;
  };
  const rows = (runs || []).map((r) => {
    return `<tr>
      <td class="tl"><a href="${u(`/org/${org.id}/reports/archive/${r.id}`)}">${dt(r.createdAt)}</a></td>
      <td>${esc(reportRu(r.report))}</td>
      <td class="tl kv">${esc(r.userEmail || '—')}</td>
      <td class="tl kv">${summ(r)}</td>
      <td style="text-align:right;white-space:nowrap">
        <a class="dl" style="padding:5px 9px;font-size:12px;margin:0 4px 0 0" href="${u(`/org/${org.id}/reports/archive/${r.id}/download/xlsx`)}">Excel</a>
        <a class="dl" style="padding:5px 9px;font-size:12px;margin:0" href="${u(`/org/${org.id}/reports/archive/${r.id}/download/json`)}">JSON</a>
        ${r.authorId === user.id ? formBtn(csrf, u(`/org/${org.id}/reports/archive/${r.id}/delete`), 'Удалить', 'mini btn-danger', 'Удалить этот отчёт из архива? Отменить нельзя.') : ''}
      </td>
    </tr>`;
  }).join('');
  return layout({
    title: `Архив отчётов — ${org.name}`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs"><a href="${u(`/org/${org.id}/reports`)}">← Отчёты</a></div>
      <h1>Архив отчётов</h1>
      <p class="sub">История запусков компании (хранится 90 дней). Откройте запуск, чтобы посмотреть содержимое или скачать. Удалить запуск может только тот, кто его создал.</p>
      <div class="section"><div class="scroll"><table class="rt">
        <thead><tr>${thT('Дата', 'Когда запущен (UTC) — ссылка на просмотр')}${thT('Отчёт', 'Тип отчёта')}${thT('Кто', 'Кто запустил')}${thT('Итоги', 'Ключевые цифры запуска')}${thT('Выгрузки', 'Скачать этот запуск')}</tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">Пока нет запусков. Соберите отчёт на странице отчётов.</td></tr>'}</tbody>
      </table></div></div>
    </div>`,
  });
}

// Просмотр одного архивного запуска (регенерируем вывод из снимка).
export function archiveViewPage({ user, csrf, base = '', org, role, run }) {
  const u = (p) => base + p;
  const when = esc(String(run.createdAt || '').slice(0, 16).replace('T', ' ')) + ' UTC';
  const dl = (k) => u(`/org/${org.id}/reports/archive/${run.id}/download/${k}`);
  const body = !run.data
    ? '<div class="section"><p class="muted">Не удалось прочитать снимок этого запуска.</p></div>'
    : run.report === 'stock'
      ? stockResults(run.data, { downloadHref: dl, whenLabel: '' })
      : run.report === 'movement'
        ? movementResults(run.data, { view: movementView({}), nav: null, downloadHref: dl, whenLabel: '' })
        : podsortResults(run.data, { downloadHref: dl, whenLabel: '' });
  const p = run.params || {};
  return layout({
    title: `Архив: ${reportRu(run.report)} — ${org.name}`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs"><a href="${u(`/org/${org.id}/reports/archive`)}">← Архив отчётов</a></div>
      <h1>${esc(reportRu(run.report))} <span class="muted" style="font-size:14px;font-weight:400">от ${when}</span></h1>
      <p class="kv">Запуск №${esc(String(run.id))}${(p.articles && p.articles.length) ? ` · артикулы: ${esc(p.articles.join(', '))}` : ''}${p.leadMin ? ` · лид ${esc(String(p.leadMin))}–${esc(String(p.leadMax))} дн · запас ${esc(String(p.cover))} дн` : ''}</p>
      ${run.authorId === user.id ? `<form method="post" action="${u(`/org/${org.id}/reports/archive/${run.id}/delete`)}" style="margin:0 0 10px" onsubmit="return confirm('Удалить этот отчёт из архива? Отменить нельзя.')">${csrfField(csrf)}<button class="btn btn-sm btn-danger" type="submit">Удалить из архива</button></form>` : ''}
      ${body}
    </div>`,
  });
}
