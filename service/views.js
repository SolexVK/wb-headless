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
/* Таблицы отчётов: заголовки по центру (гориз.+верт.), данные по центру, кроме .tl (Цвет/Статус — слева). */
.rt th,.rt td{text-align:center;vertical-align:middle}
.rt td.tl{text-align:left}
.rt .num{text-align:center;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
.note{background:#E8EEFF;border:1px solid #C7D6FF;color:#2A46A8;border-radius:9px;padding:10px 12px;margin-bottom:12px;font-size:13.5px}
@media(prefers-color-scheme:dark){.note{background:#12203f;border-color:#243a63;color:#9DB4F5}}
.gloss{margin:2px 0 0}.gloss dt{font-weight:700;font-size:13px;margin-top:9px}.gloss dd{margin:1px 0 0;color:var(--muted);font-size:12.5px}
th[title],label[title],.hashelp{cursor:help;border-bottom:1px dotted transparent}
th[title]{text-decoration:underline dotted 1px;text-underline-offset:3px}
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
        <form method="post" action="${u(`/org/${org.id}/leave`)}" style="margin-top:8px" onsubmit="return confirm('Покинуть компанию «${esc(org.name)}»? Доступ к её отчётам пропадёт.')">
          ${csrfField(csrf)}<button class="btn btn-sm btn-danger" type="submit">Покинуть компанию</button>
        </form>
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
  const leave = owner ? '' : `
    <form method="post" action="${u(`/org/${org.id}/leave`)}" style="margin-top:20px" onsubmit="return confirm('Покинуть компанию «${esc(org.name)}»? Доступ к её отчётам пропадёт.')">
      ${csrfField(csrf)}<button class="btn btn-sm btn-danger" type="submit">Покинуть компанию</button>
    </form>`;
  return layout({
    title: `Отчёты — ${org.name}`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs">${crumb}</div>
      <h1>${esc(org.name)} — отчёты</h1>
      ${cabLine}
      <div class="grid" style="margin-top:14px">
        ${card(`/org/${org.id}/reports/podsort`, 'Подсорт', 'Рекомендации к заказу по складам и размерам + пробный завоз', !!active)}
        ${card(`/org/${org.id}/reports/podsort`, 'Остатки', 'Остатки FBS по артикулам и цветам', false)}
      </div>
      ${leave}
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
    const pivotHead = `<tr>${thT('Арт', 'Номер артикула (модель)')}${thT('Цвет', 'Вариант/цвет исполнения')}${thT('Разм', 'Размер (techSize карточки)')}${cols.map((c) => thT(c, `Сколько заказать на склад «${c}»`, 'num')).join('')}${thT('Итого', 'Сумма подсорта по строке (все склады)', 'num')}</tr>`;
    const pivotRows = (s.pivot || []).map((r) => `<tr><td>${esc(r.articleNum)}</td><td class="tl">${esc(r.variant)}</td><td>${esc(r.techSize)}</td>${cols.map((c) => `<td class="num">${r.byWarehouse?.[c] ? nf(r.byWarehouse[c]) : ''}</td>`).join('')}<td class="num"><b>${nf(r.total)}</b></td></tr>`).join('');
    const pivotTable = pivotRows
      ? `<div class="scroll"><table class="rt"><thead>${pivotHead}</thead><tbody>${pivotRows}</tbody></table></div>`
      : '<p class="muted">Подсорт не требуется (0 строк).</p>';

    // Детально по складам.
    const whBlocks = (s.warehouses || []).filter((w) => w.rows?.length).map((w) => `
      <details><summary>${esc(w.name)} — остаток ${nf(w.stockUnits)} · подсорт ${nf(w.reorderUnits)} шт · строк ${w.rows.length}</summary>
        <div class="scroll"><table class="rt">
          <thead><tr>${thT('Арт', 'Номер артикула (модель)')}${thT('Цвет', 'Вариант/цвет')}${thT('Разм', 'Размер')}${thT('Остаток', 'Текущий остаток этого размера на этом складе (FBS)', 'num')}${thT('/дн', 'Средняя скорость продаж, шт/день, за окно скорости', 'num')}${thT('Дней до 0', 'На сколько дней хватит остатка при текущей скорости (∞ — продаж нет)', 'num')}${thT('Подсорт', 'Рекомендация к заказу = скорость × горизонт − остаток (округление вверх, минимум 0)', 'num')}${thT('Статус', 'Оценка риска нехватки — см. «Пояснения» выше')}</tr></thead>
          <tbody>${w.rows.map((r) => `<tr><td>${esc(r.articleNum)}</td><td class="tl">${esc(r.variant)}</td><td>${esc(r.techSize)}</td><td class="num">${nf(r.stock)}</td><td class="num">${esc(String(r.perDay))}</td><td class="num">${r.daysToZero == null ? '∞' : esc(String(r.daysToZero))}</td><td class="num"><b>${nf(r.reorderQty)}</b></td><td class="tl">${statusBadge(r.status)}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>`).join('');

    // Пробный завоз.
    const seedRows = (s.seedGrid || []).map((r) => `<tr><td>${esc(r.articleNum)}</td><td class="tl">${esc(r.variant)}</td><td>${esc(r.techSize)}</td><td><span class="badge ${r.kind === 'новинка' ? 'st-ok' : 'st-risk'}">${esc(r.kind)}</span></td><td class="num"><b>${nf(r.seedTotal)}</b></td></tr>`).join('');
    const seedBlock = seedRows
      ? `<details><summary>Пробный завоз — ${nf(t.seedRows)} строк (${nf(t.seedNovelty)} новинок + ${nf(t.seedRefill)} докладок) = ${nf(t.seedUnits)} шт</summary>
          <div class="scroll"><table class="rt"><thead><tr>${thT('Арт', 'Номер артикула')}${thT('Цвет', 'Вариант/цвет')}${thT('Разм', 'Размер')}${thT('Тип', 'Новинка — карточки ещё не было ни на одном FF-складе; докладка — есть на других складах, но не на этом')}${thT('Кол-во', 'Всего штук к пробному завозу по всем складам (по seedMin на размер)', 'num')}</tr></thead><tbody>${seedRows}</tbody></table></div></details>`
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
