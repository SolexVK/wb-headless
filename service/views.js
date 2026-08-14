// service/views.js — минимальный серверный рендер (без шаблонизатора).
// Утилитарные страницы авторизации + заглушка кабинета. Экранируем весь ввод.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--ground:#EDF0F6;--surface:#fff;--ink:#141A24;--muted:#57617A;--line:#E1E7F1;--accent:#4B57C6;--accent-d:#3A45AE;--danger:#C43A50;--ok:#1C8A5B;--radius:12px}
@media(prefers-color-scheme:dark){:root{--ground:#0C0F16;--surface:#141926;--ink:#E7ECF5;--muted:#9AA4B8;--line:#232B3C;--accent:#8E97F5;--accent-d:#A7AEFB}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.55}
a{color:var(--accent-d);text-decoration:none}a:hover{text-decoration:underline}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line);background:var(--surface)}
.top .brand{font-weight:750;letter-spacing:-.01em}.top .brand span{color:var(--accent-d)}
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
`;

function layout({ title, body, user, csrf }) {
  const nav = user
    ? `<div class="top"><div class="brand">FBS<span>·</span>сервис</div>
        <div style="display:flex;gap:12px;align-items:center">
          <span class="muted" style="font-size:13px">${esc(user.email)}</span>
          <form method="post" action="/logout">${csrfField(csrf)}<button class="btn btn-sm" type="submit">Выйти</button></form>
        </div></div>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>${nav}${body}</body></html>`;
}

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const errBox = (e) => (e ? `<div class="err">${esc(e)}</div>` : '');

export function loginPage({ csrf, error, email }) {
  return layout({
    title: 'Вход — FBS-сервис',
    body: `<div class="center"><div class="card auth">
      <h1>Вход</h1><p class="sub">FBS-сервис отчётов и подсорта</p>
      ${errBox(error)}
      <form method="post" action="/login">${csrfField(csrf)}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" value="${esc(email || '')}" required>
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn" type="submit">Войти</button>
      </form>
      <div class="alt">Нет аккаунта? <a href="/register">Зарегистрироваться</a></div>
    </div></div>`,
  });
}

export function registerPage({ csrf, error, email, name }) {
  return layout({
    title: 'Регистрация — FBS-сервис',
    body: `<div class="center"><div class="card auth">
      <h1>Регистрация</h1><p class="sub">Создаётся аккаунт и ваша организация — потом подключите кабинет WB</p>
      ${errBox(error)}
      <form method="post" action="/register">${csrfField(csrf)}
        <label for="name">Имя</label>
        <input id="name" name="name" type="text" autocomplete="name" value="${esc(name || '')}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" value="${esc(email || '')}" required>
        <label for="password">Пароль <span class="muted">(мин. 8 символов)</span></label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <button class="btn" type="submit">Создать аккаунт</button>
      </form>
      <div class="alt">Уже есть аккаунт? <a href="/login">Войти</a></div>
    </div></div>`,
  });
}

export function homePage({ user, orgs, csrf }) {
  const orgList = orgs.length
    ? orgs.map((o) => `<div class="tile"><h3>${esc(o.name)} <span class="pill">${esc(o.role)}</span></h3>
        <p>Кабинеты и отчёты появятся здесь <span class="muted">(Фазы 1–2)</span></p></div>`).join('')
    : `<div class="tile"><p class="muted">Организаций пока нет.</p></div>`;
  return layout({
    title: 'FBS-сервис',
    user, csrf,
    body: `<div class="wrap">
      <h1>Здравствуйте, ${esc(user.name || user.email)}</h1>
      <p class="sub">Ваши организации. Дальше — подключение кабинета WB и выбор отчётов.</p>
      <div class="grid">${orgList}</div>
      <div class="tile soon" style="margin-top:16px">
        <h3>Отчёты <span class="pill">скоро</span></h3>
        <p>Подсорт (с формой), Остатки, Передано/Принято, Ретроспектива — Фаза 2.</p>
      </div>
    </div>`,
  });
}
