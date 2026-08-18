// service/views/account.js — страницы входа, восстановления пароля, регистрации,
// домашней, компании/кабинета, приглашений и супер-админки. Выделено из views.js (P1c).
import { esc, layout, csrfField, errBox, noteBox, thT, roleRu, formBtn, okBox, okOrWarn } from './kit.js';

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

// Блок созданной ссылки-приглашения: кликабельная ссылка + поле для копирования.
function inviteCreatedBox({ email, url }) {
  return `<div class="ok">
    Ссылка-приглашение для <b>${esc(email)}</b> создана (действует 7 дней). Отправьте её человеку — принять сможет только этот email.
    <div style="margin-top:8px"><a href="${esc(url)}" style="font-weight:600;word-break:break-all">${esc(url)}</a></div>
    <input class="linkbox" style="width:100%;margin-top:8px" readonly value="${esc(url)}" onclick="this.select()" aria-label="Ссылка-приглашение">
  </div>`;
}
