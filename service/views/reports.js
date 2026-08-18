// service/views/reports.js — страницы отчётов (подсорт, остатки, движение,
// география, логистика) и архива запусков. Выделено из views.js (P1c).
import {
  esc, layout, csrfField, thT, roleRu, formBtn,
  nf, fmtHrs, DKAC, dkKpi, dkInsights, ph, statusBadge, whenLabel, downloadBar, runStatus,
} from './kit.js';
import { reportRu } from '../report-names.js';

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
  // Карточка отчёта: краткое «что даёт» + строка «Когда открывать» (ориентир для новичка).
  const card = (href, title, desc, when, ready) => ready
    ? `<a class="tile" href="${u(href)}" style="display:block"><h3>${esc(title)}</h3><p>${esc(desc)}</p><p class="kv" style="margin:8px 0 0;font-size:12px"><b>Когда открывать:</b> ${esc(when)} →</p></a>`
    : `<div class="tile soon"><h3>${esc(title)} <span class="pill">скоро</span></h3><p>${esc(desc)}</p></div>`;
  const crumb = owner ? `<a href="${u(`/org/${org.id}`)}">← ${esc(org.name)}</a>` : `<a href="${u('/')}">← Компании</a>`;
  return layout({
    title: `Отчёты — ${org.name}`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs">${crumb}</div>
      <h1>${esc(org.name)} — отчёты</h1>
      ${cabLine}
      <div class="grid" style="margin-top:14px">
        ${card(`/org/${org.id}/reports/podsort`, 'Подсорт',
          'Сколько и каких размеров дозаказать на каждый фулфилмент: скорость продаж по складу, дни до нуля, рекомендация к заказу + пробный завоз новинок и докладок.',
          'перед формированием поставки на фулфилменты', !!active)}
        ${card(`/org/${org.id}/reports/stock`, 'Остатки',
          'Что лежит на складах прямо сейчас — по фулфилментам и в разрезе артикул+цвет × склад. Копит ежедневные снимки: можно смотреть остаток на любую прошлую дату.',
          'быстрый срез наличия и динамика запаса', !!active)}
        ${card(`/org/${org.id}/reports/movement`, 'Движение заказов',
          'Сколько заказов принято на фулфилмент и передано в доставку — по дням и складам, в штуках и рублях (себестоимость / цена продажи / цена заказа), со сравнением периодов.',
          'контроль темпа отгрузок и денежного потока по складам', !!active)}
        ${card(`/org/${org.id}/reports/geo`, 'География',
          'Продажи и возвраты по регионам и округам России + процент возврата. Возвраты привязаны к исходному фулфилменту отгрузки (откуда товар уехал).',
          'управление возвратами и выбор регионов/складов', !!active)}
        ${card(`/org/${org.id}/reports/logistics`, 'Логистика',
          'Сроки на каждом этапе: сборка на фулфилменте (создание → отгрузка) и скорость доставки от фулфилмента до клиента, по ФФ, регионам и дням.',
          'контроль SLA сборки и скорости доставки по направлениям', !!active)}
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
  const statusBox = runStatus(job, active, {
    verb: 'Идёт пересчёт', hint: 'Страница обновится сама. Это может занять 1–3 минуты (запрос к WB).',
    errPrefix: 'Ошибка пересчёта: ', doneMsg: 'Пересчёт завершён.',
  });

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
      whenLabel: whenLabel(latest.createdAt),
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

// Рендер результатов подсорта из снимка (переиспользуется на странице отчёта и в архиве).
// downloadHref(kind) → URL выгрузки; whenLabel — подпись «обновлено …».
function podsortResults(s, { downloadHref, whenLabel }) {
  const t = s.totals || {};
  const tiles = [
    dkKpi(nf(t.reorderUnits), 'штук к подсорту', { icon: '🛒', accent: DKAC.green }),
    dkKpi(nf(t.riskRows), 'строк в риске', { icon: '⚠️', accent: DKAC.red }),
    dkKpi(nf(t.seedUnits), 'штук пробного завоза', { icon: '🌱', accent: DKAC.violet }),
    dkKpi(nf(t.warehouses), 'складов', { icon: '🏭', accent: DKAC.blue }),
    dkKpi(nf(t.nomenclature), 'номенклатура', { icon: '🎨', accent: DKAC.teal }),
  ].join('');
  const topWh = [...(s.warehouses || [])].sort((a, b) => (b.reorderUnits || 0) - (a.reorderUnits || 0))[0];
  const critCount = (s.warehouses || []).reduce((a, w) => a + (w.rows || []).filter((r) => r.status === 'нет остатка' || r.status === 'разрыв до поставки').length, 0);
  const insightRow = dkInsights([
    topWh && topWh.reorderUnits ? { icon: '🏭', accent: DKAC.blue, text: `Больше всего дозаказа: <b>${esc(topWh.name)}</b> — ${nf(topWh.reorderUnits)} шт` } : null,
    critCount ? { icon: '🚨', accent: DKAC.red, text: `Критично (нет остатка): <b>${nf(critCount)}</b> позиций` } : { icon: '✅', accent: DKAC.green, text: 'Критичных позиций (нет остатка) нет' },
    { icon: '🌱', accent: DKAC.violet, text: `Завоз: <b>${nf(t.seedNovelty)}</b> новинок + <b>${nf(t.seedRefill)}</b> докладок` },
  ]);

  const cols = s.warehouseList || [];
  // Остаток по (артикул|цвет|размер) × склад — из детальных строк складов.
  const stockMap = {};
  for (const w of (s.warehouses || [])) for (const r of (w.rows || [])) { const k = `${r.articleNum}|${r.variant}|${r.techSize}`; (stockMap[k] = stockMap[k] || {}); stockMap[k][w.name] = (stockMap[k][w.name] || 0) + (r.stock || 0); }
  const stockOf = (p) => stockMap[`${p.articleNum}|${p.variant}|${p.techSize}`] || {};
  const pivotHead = `<tr>${thT('Арт', 'Номер артикула (модель)')}${thT('Цвет', 'Вариант/цвет исполнения')}${thT('Разм', 'Размер')}${cols.map((c) => thT(c, `Остаток на «${c}»`, 'num oscol print-hide')).join('')}${thT('Ост.∑', 'Итого остаток по строке', 'num oscol print-hide')}${cols.map((c) => thT(c, `Подсорт: сколько заказать на «${c}»`, 'num')).join('')}${thT('Итого', 'Итого подсорт по строке', 'num')}</tr>`;
  const pivotRows = (s.pivot || []).map((r) => {
    const st = stockOf(r); const stT = cols.reduce((a, c) => a + (st[c] || 0), 0);
    return `<tr><td data-v="${esc(r.articleNum)}">${esc(r.articleNum)}</td><td class="tl">${esc(r.variant)}</td><td>${esc(r.techSize)}</td>${cols.map((c) => `<td class="num oscol print-hide" data-v="${st[c] || 0}">${st[c] ? nf(st[c]) : ''}</td>`).join('')}<td class="num oscol print-hide" data-v="${stT}">${nf(stT)}</td>${cols.map((c) => `<td class="num" data-v="${r.byWarehouse?.[c] || 0}">${r.byWarehouse?.[c] ? nf(r.byWarehouse[c]) : '·'}</td>`).join('')}<td class="num" data-v="${r.total}"><b>${nf(r.total)}</b></td></tr>`;
  }).join('');
  const pivotTable = pivotRows
    ? `<p class="blk-hint">Слева — <span class="os">Остаток по складам</span>, справа (после «Ост.∑») — <span class="ps">Подсорт по складам</span>. Прокрутите таблицу вправо; первые 3 столбца закреплены. Клик по заголовку — сортировка.</p><div class="scroll"><table class="rt sortable frozen3"><thead>${pivotHead}</thead><tbody>${pivotRows}</tbody></table></div>`
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
      ${whenLabel ? `<p class="kv" style="margin:0 0 12px">Обновлено: <b>${esc(whenLabel)}</b></p>` : ''}
      <div class="dk-kpis">${tiles}</div>
      ${insightRow}
      <div style="margin-bottom:14px">${downloadBar(downloadHref)}</div>
      ${ph('📊', 'Сводная: подсорт по размерам × склад', `${nf((s.pivot || []).length)} строк`, DKAC.indigo)}
      ${pivotTable}
      <div style="margin-top:22px"></div>
      ${ph('🏭', 'Детально по складам', '', DKAC.blue)}
      ${whBlocks || '<p class="muted">Нет строк.</p>'}
      ${seedBlock}
    </div>`;
}

// Фон тепловой ячейки (последовательная шкала к акценту).
const heatCell = (v, max) => (!v || v <= 0 ? '' : ` style="background:color-mix(in srgb, var(--c-teal) ${(10 + 80 * Math.min(1, v / (max || 1))).toFixed(0)}%, transparent)"`);

// Рендер результатов остатков из снимка (страница отчёта и архив).
function stockResults(s, { downloadHref, whenLabel }) {
  const t = s.totals || {};
  const whs = [...(s.warehouses || [])].filter((w) => w.totalQuantity > 0).sort((a, b) => b.totalQuantity - a.totalQuantity);
  const grand = t.grandTotal || whs.reduce((a, w) => a + w.totalQuantity, 0);
  const top = whs[0];
  const activeN = t.activeWarehouses ?? whs.length;
  const totalSku = whs.reduce((a, w) => a + (w.skuInStock || 0), 0);
  const tiles = [
    dkKpi(nf(grand), 'штук на FBS (всего)', { icon: '📦', accent: DKAC.green }),
    dkKpi(nf(activeN), 'активных складов', { icon: '🏭', accent: DKAC.blue }),
    dkKpi(nf(t.articleCount), 'артикул + цвет (позиций)', { icon: '🎨', accent: DKAC.violet }),
    dkKpi(nf(totalSku), 'SKU в наличии', { icon: '🔖', accent: DKAC.amber }),
    dkKpi(nf(activeN ? Math.round(grand / activeN) : 0), 'в среднем на склад, шт', { icon: '⚖️', accent: DKAC.teal }),
  ].join('');
  const topArt = (s.articles || [])[0];
  const top3 = whs.slice(0, 3).reduce((a, w) => a + w.totalQuantity, 0);
  const insightRow = dkInsights([
    top ? { icon: '🏆', accent: DKAC.green, text: `Больше всего: <b>${esc(top.name)}</b> — ${nf(top.totalQuantity)} шт (${(top.totalQuantity / (grand || 1) * 100).toFixed(1)}%)` } : null,
    topArt ? { icon: '🎨', accent: DKAC.violet, text: `Топ-артикул: <b>${esc(topArt.articleNum)} ${esc(topArt.variant)}</b> — ${nf(topArt.total)} шт` } : null,
    { icon: '🏭', accent: DKAC.blue, text: `Топ-3 склада держат <b>${(top3 / (grand || 1) * 100).toFixed(0)}%</b> остатка` },
  ]);

  const whMax = Math.max(1, ...whs.map((w) => w.totalQuantity));
  const whRows = whs.map((w) => `<tr><td class="tl">${esc(w.name)}</td><td class="num" data-v="${w.totalQuantity}"${heatCell(w.totalQuantity, whMax)}>${nf(w.totalQuantity)}</td><td class="num" data-v="${w.skuInStock}">${nf(w.skuInStock)}</td></tr>`).join('');
  const whTable = `<div class="scroll"><table class="rt sortable"><thead><tr>${thT('Фулфилмент', 'Склад продавца (FBS)')}${thT('Остаток, шт', 'Всего единиц на складе', 'num')}${thT('Позиций (SKU)', 'Сколько штрихкодов в наличии', 'num')}</tr></thead><tbody>${whRows}</tbody></table></div>`;

  const cols = s.warehouseList || [];
  const cellMax = Math.max(1, ...(s.articles || []).flatMap((a) => cols.map((c) => a.byWarehouse?.[c] || 0)));
  const head = `<tr>${thT('Арт', 'Номер артикула')}${thT('Цвет', 'Вариант/цвет')}${cols.map((c) => thT(c, `Остаток на «${c}»`, 'num')).join('')}${thT('Итого', 'Всего по всем складам', 'num')}</tr>`;
  const rows = (s.articles || []).map((a) => `<tr><td data-v="${esc(a.articleNum)}">${esc(a.articleNum)}</td><td class="tl">${esc(a.variant)}</td>${cols.map((c) => { const v = a.byWarehouse?.[c] || 0; return `<td class="num" data-v="${v}"${heatCell(v, cellMax)}>${v ? nf(v) : ''}</td>`; }).join('')}<td class="num" data-v="${a.total}"><b>${nf(a.total)}</b></td></tr>`).join('');
  const matrix = rows ? `<div class="scroll"><table class="rt sortable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Нет остатков.</p>';

  return `<div class="section">
      <p class="kv" style="margin:0 0 12px">Текущий остаток FBS по складам и артикулам/цветам.${whenLabel ? ` <b>${esc(whenLabel)}</b>` : ''}</p>
      <div class="dk-kpis">${tiles}</div>
      ${insightRow}
      <div style="margin-bottom:14px">${downloadBar(downloadHref)}</div>
      ${ph('🏭', 'По фулфилментам', `всего ${nf(grand)} шт`, DKAC.blue)}
      ${whTable}
      <div style="margin-top:22px"></div>
      ${ph('🎨', 'Остаток: артикул + цвет × склад', 'интенсивность = величина', DKAC.violet)}
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
  const statusBox = runStatus(job, active, { verb: 'Получаю остатки' });

  // Показываем выбранный снимок из архива (на дату) либо последний.
  const view = selected || latest;
  const isArchived = !!selected;
  const whenLbl = whenLabel(view?.createdAt);
  const dlHref = isArchived
    ? (k) => u(`/org/${org.id}/reports/archive/${selected.id}/download/${k}`)
    : (k) => u(`/org/${org.id}/reports/stock/download/${k}`);
  const results = view?.data
    ? `${isArchived ? `<div class="section" style="padding-bottom:0"><div class="warn" style="margin:0">📅 Снимок остатков на <b>${esc(whenLbl)}</b> (из архива). <a href="${u(`/org/${org.id}/reports/stock`)}">← к текущему</a></div></div>` : ''}
       ${stockResults(view.data, { downloadHref: dlHref, whenLabel: whenLbl })}`
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
const MV_PALETTE = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
const MV_FOCUS = { accepted: 'Принято', delivered: 'Передано', diff: 'Разница' };

// Нормализация состояния просмотра (из query) с дефолтами.
const MV_BASIS = { cost: 'Себестоимость', sale: 'Ср. цена 7д', order: 'Цена заказа' };
export function movementView(q = {}) {
  const one = (v, allowed, def) => (allowed.includes(String(v)) ? String(v) : def);
  return {
    focus: one(q.focus, ['accepted', 'delivered', 'diff'], 'delivered'),
    unit: one(q.unit, ['count', 'money'], 'count'),
    basis: one(q.basis, ['cost', 'sale', 'order'], 'cost'),
    cost: Math.min(100000, Math.max(0, Math.round(Number(q.cost)) || 620)),
    gran: one(q.gran, ['day', 'week'], 'day'),
    ov: one(q.ov, ['none', 'cum', 'ma'], 'none'),
    cmp: String(q.cmp) === '1' ? '1' : '0',
    hide: String(q.hide ?? '').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x >= 0),
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
// Единица «шт» → count; «₽» → по базе оценки: себестоимость (count×cost),
// ср. цена продажи 7д (moneyAvg) или цена заказа (money).
function mvCell(d, view, name) {
  const fld = (blk, f) => (name ? ((blk?.byFulfillment?.[name] || {})[f] || 0) : (blk?.[f] || 0));
  const value = (blk) => {
    if (view.unit === 'count') return fld(blk, 'count');
    if (view.basis === 'cost') return fld(blk, 'count') * (view.cost || 620);
    if (view.basis === 'sale') return fld(blk, 'moneyAvg');
    return fld(blk, 'money');
  };
  if (view.focus === 'accepted') return value(d.accepted);
  if (view.focus === 'delivered') return value(d.delivered);
  return value(d.delivered) - value(d.accepted);
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
function mvChart(buckets, lines, money = false) {
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
    paths += `<polyline points="${pts}" fill="none" stroke="${ln.color}" stroke-width="${ln.bold ? 3.4 : 1.6}" stroke-linejoin="round" stroke-linecap="round"${ln.bold ? '' : ' opacity="0.92"'}/>`;
  }
  const cross = `<line class="rt-cross" x1="0" y1="${pt}" x2="0" y2="${pt + ih}" style="display:none"/>`;
  const bw = n > 1 ? iw / (n - 1) : iw;
  const hits = buckets.map((b, i) => {
    const tip = lines.map((ln) => ({ n: ln.name, c: ln.color, v: mvVal(ln.values[i] || 0, money) }));
    return `<rect class="rt-hit" x="${(x(i) - bw / 2).toFixed(1)}" y="${pt}" width="${bw.toFixed(1)}" height="${ih}" data-cx="${x(i).toFixed(1)}" data-label="${esc(b.label)}" data-tip="${esc(JSON.stringify(tip))}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="mv-chart" preserveAspectRatio="xMidYMid meet" role="img" aria-label="График движения заказов">${grid}${zero}${paths}${cross}${hits}${xlab}</svg>`;
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
  // Фильтр складов (view-time): показываем только не скрытые индексы.
  const hideSet = new Set(view.hide || []);
  const ffShown = ffAll.filter((_, i) => !hideSet.has(i));
  const empty = ffShown.length === 0;

  const cost = view.cost || 620;
  // Сводные плитки: штуки + три базы денег (себестоимость / ср.продажа / заказ) по «передано» — по показанным складам.
  const fldShown = (blk, f) => ffShown.reduce((a, n) => a + ((blk?.byFulfillment?.[n] || {})[f] || 0), 0);
  const sumC = (k) => display.reduce((s, d) => s + fldShown(d[k], 'count'), 0);
  const sumF = (k, f) => display.reduce((s, d) => s + fldShown(d[k], f), 0);
  const accC = sumC('accepted'), delC = sumC('delivered');
  const diffKpi = delC - accC;
  const avgCheck = delC ? Math.round(sumF('delivered', 'money') / delC) : 0;
  const tiles = [
    dkKpi(nf(accC), 'Принято, шт', { icon: '📥', accent: DKAC.blue }),
    dkKpi(nf(delC), 'Передано, шт', { icon: '🚚', accent: DKAC.green }),
    dkKpi(`${diffKpi >= 0 ? '+' : ''}${nf(diffKpi)}`, 'Разница, шт', { icon: diffKpi < 0 ? '📉' : '📈', accent: diffKpi < 0 ? DKAC.red : DKAC.teal }),
    dkKpi(nf(Math.round(delC * cost)), `Себест. передано, ₽ (${nf(cost)}/шт)`, { icon: '🏷️', accent: DKAC.violet }),
    dkKpi(nf(avgCheck), 'Ср. чек, ₽/шт', { icon: '💰', accent: DKAC.indigo }),
  ].join('');
  // Инсайты за период (по показанным складам).
  const diffC = delC - accC;
  const ffRank = ffShown.map((n) => ({ n, v: display.reduce((a, d) => a + ((d.delivered?.byFulfillment?.[n] || {}).count || 0), 0) })).sort((a, b) => b.v - a.v);
  const l3 = display.slice(-3);
  const l3a = l3.reduce((a, d) => a + fldShown(d.accepted, 'count'), 0), l3d = l3.reduce((a, d) => a + fldShown(d.delivered, 'count'), 0);
  const peak = display.reduce((m, d) => { const v = fldShown(d.delivered, 'count'); return v > m.v ? { v, date: d.date } : m; }, { v: 0, date: '' });
  const insightRow = dkInsights([
    ffRank[0] && ffRank[0].v ? { icon: '🏆', accent: DKAC.green, text: `Лидер по отгрузкам: <b>${esc(ffRank[0].n)}</b> — ${nf(ffRank[0].v)} шт` } : null,
    peak.v ? { icon: '⚡', accent: DKAC.amber, text: `Пик отгрузки: <b>${esc(peak.date.slice(5))}</b> — ${nf(peak.v)} шт` } : null,
    { icon: l3d >= l3a ? '✅' : '⏳', accent: l3d >= l3a ? DKAC.green : DKAC.amber, text: `Последние 3 дня: принято ${nf(l3a)} · передано <b>${nf(l3d)}</b>` },
  ]);

  // Тумблеры.
  const seg = (lab, key, opts) => (nav ? `<div class="mv-seg"><span class="lab">${esc(lab)}</span>${opts.map((o) => `<a class="mv-chip${view[key] === o.v ? ' on' : ''}" href="${nav({ [key]: o.v })}">${esc(o.label)}</a>`).join('')}</div>` : '');
  // База оценки — только когда единица ₽. Ввод себестоимости — только при базе «Себестоимость».
  const basisSeg = (nav && money) ? seg('База ₽', 'basis', [{ v: 'cost', label: 'Себестоимость' }, { v: 'sale', label: 'Ср. цена 7д' }, { v: 'order', label: 'Цена заказа' }]) : '';
  // Выбор складов: чип на каждый склад (вкл/выкл), + «сбросить».
  const whChips = (nav && ffAll.length > 1) ? `<div class="mv-seg"><span class="lab">Склады</span>${ffAll.map((n, i) => {
    const hid = hideSet.has(i);
    const next = hid ? (view.hide || []).filter((x) => x !== i) : [...(view.hide || []), i];
    return `<a class="mv-chip${hid ? '' : ' on'}" href="${nav({ hide: next })}">${esc(n)}</a>`;
  }).join('')}${(view.hide && view.hide.length) ? `<a class="mv-chip" href="${nav({ hide: [] })}">сбросить</a>` : ''}</div>` : '';
  const hidden = ['focus', 'unit', 'basis', 'gran', 'ov', 'cmp'].map((k) => `<input type="hidden" name="${k}" value="${esc(view[k])}">`).join('') + `<input type="hidden" name="hide" value="${esc((view.hide || []).join(','))}">`;
  const costInput = (nav && money && view.basis === 'cost')
    ? `<form method="get" action="${nav({})}" class="mv-seg" style="margin:0 16px 8px 0">${hidden}<span class="lab">Себест., ₽/шт</span><input name="cost" type="number" min="0" value="${esc(String(cost))}" style="width:92px" onchange="this.form.submit()"><noscript><button class="btn btn-sm" type="submit">OK</button></noscript></form>`
    : '';
  const salesWarn = (money && view.basis === 'sale' && snap.salesAvailable === false)
    ? '<div class="warn" style="margin:0 0 8px">Статистика продаж недоступна на этом токене — «ср. цена 7д» замещена ценой заказа.</div>' : '';
  const toolbar = nav ? `<div class="mv-bar">
    ${seg('Показатель', 'focus', [{ v: 'accepted', label: 'Принято' }, { v: 'delivered', label: 'Передано' }, { v: 'diff', label: 'Разница' }])}
    ${seg('Единица', 'unit', [{ v: 'count', label: 'шт' }, { v: 'money', label: '₽' }])}
    ${basisSeg}
    ${costInput}
    ${seg('Разбивка', 'gran', [{ v: 'day', label: 'День' }, { v: 'week', label: 'Неделя' }])}
    ${seg('График', 'ov', [{ v: 'none', label: '—' }, { v: 'cum', label: 'Нарастающий' }, { v: 'ma', label: 'Скользящее' }])}
    ${seg('Сравнение', 'cmp', [{ v: '1', label: 'вкл' }, { v: '0', label: 'выкл' }])}
    ${whChips}
  </div>${salesWarn}` : '';

  if (empty) {
    return `<div class="section">${toolbar}<p class="warn" style="margin:8px 0 0">Выберите хотя бы один склад в фильтре «Склады».</p></div>`;
  }

  // Корзины + линии графика (по показанным складам).
  const buckets = mvBuckets(display, view, ffShown);
  const win = view.gran === 'day' ? 7 : 3;
  const lines = ffShown.map((n, i) => ({ name: n, color: MV_PALETTE[ffAll.indexOf(n) % MV_PALETTE.length], bold: false, values: mvOverlay(buckets.map((b) => b.byFf[n] || 0), view.ov, win) }));
  const totalLine = { name: 'Итого', color: 'var(--total)', bold: true, values: mvOverlay(buckets.map((b) => b.total), view.ov, win) };
  const chartLines = ffShown.length > 1 ? [...lines, totalLine] : lines;
  const legend = `<div class="mv-legend">${chartLines.map((ln) => `<span><i style="background:${ln.color}"></i>${esc(ln.name)}</span>`).join('')}</div>`;
  const chart = buckets.length ? `${mvChart(buckets, chartLines, money)}${legend}` : '<p class="muted">Нет данных за период.</p>';

  // Таблица корзина × фулфилмент.
  const head = `<tr>${thT(view.gran === 'day' ? 'День' : 'Неделя', 'Период')}${ffShown.map((n) => thT(n, `${MV_FOCUS[view.focus]} — ${n}`, 'num')).join('')}${thT('Итого', 'Сумма по строке', 'num')}</tr>`;
  const rows = buckets.map((b) => `<tr><td class="tl">${esc(b.label)}</td>${ffShown.map((n) => `<td class="num" data-v="${b.byFf[n] || 0}">${b.byFf[n] ? mvVal(b.byFf[n], money) : ''}</td>`).join('')}<td class="num" data-v="${b.total}"><b>${mvVal(b.total, money)}</b></td></tr>`).join('');
  const colTotals = ffShown.map((n) => buckets.reduce((s, b) => s + (b.byFf[n] || 0), 0));
  const grand = buckets.reduce((s, b) => s + b.total, 0);
  const footer = `<tr class="nosort" style="border-top:2px solid var(--line)"><td class="tl"><b>Итого</b></td>${colTotals.map((v) => `<td class="num"><b>${mvVal(v, money)}</b></td>`).join('')}<td class="num"><b>${mvVal(grand, money)}</b></td></tr>`;
  const table = buckets.length ? `<div class="scroll"><table class="rt sortable"><thead>${head}</thead><tbody>${rows}${footer}</tbody></table></div>` : '';

  // Сравнение с прошлым периодом.
  let compare = '';
  if (view.cmp === '1') {
    if (!prev.length) compare = '<p class="muted">Недостаточно истории для сравнения с прошлым периодом.</p>';
    else {
      const curBy = (n) => display.reduce((s, d) => s + mvCell(d, view, n), 0);
      const prvBy = (n) => prev.reduce((s, d) => s + mvCell(d, view, n), 0);
      const pct = (c, p) => (p ? `${c - p >= 0 ? '+' : ''}${Math.round((c - p) / Math.abs(p) * 100)}%` : (c ? '—' : '0%'));
      const line = (label, c, p) => `<tr><td class="tl">${esc(label)}</td><td class="num">${mvVal(c, money)}</td><td class="num">${mvVal(p, money)}</td><td class="num">${c - p >= 0 ? '+' : ''}${mvVal(c - p, money)}</td><td class="num">${esc(pct(c, p))}</td></tr>`;
      const curTot = ffShown.reduce((s, n) => s + curBy(n), 0), prvTot = ffShown.reduce((s, n) => s + prvBy(n), 0);
      const body = ffShown.map((n) => line(n, curBy(n), prvBy(n))).join('') + `<tr style="border-top:2px solid var(--line)"><td class="tl"><b>Итого</b></td><td class="num"><b>${mvVal(curTot, money)}</b></td><td class="num"><b>${mvVal(prvTot, money)}</b></td><td class="num"><b>${curTot - prvTot >= 0 ? '+' : ''}${mvVal(curTot - prvTot, money)}</b></td><td class="num"><b>${esc(pct(curTot, prvTot))}</b></td></tr>`;
      compare = `${ph('🔀', 'Сравнение с прошлым периодом', `${esc(MV_FOCUS[view.focus])} · ${N} дн ↔ пред. ${N} дн`, DKAC.amber)}
        <div class="scroll"><table class="rt"><thead><tr>${thT('Фулфилмент', 'Склад')}${thT('Текущий', 'Текущий период', 'num')}${thT('Прошлый', 'Предыдущий период', 'num')}${thT('Δ', 'Разница', 'num')}${thT('%', 'Изменение', 'num')}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
  }

  const artLine = (snap.articles && snap.articles.length) ? ` · артикулы: ${esc(snap.articles.join(', '))}` : '';
  const focusLabel = `${MV_FOCUS[view.focus]}${money ? `, ₽ (${MV_BASIS[view.basis]})` : ', шт'} · ${N} дн${whenLabel ? ` · ${whenLabel}` : ''}`;
  return `<div class="section">
      <p class="kv" style="margin:0 0 12px">Период по МСК (${esc(snap.tz || '+03:00')})${artLine}. «Принято» — по дате создания задания, «Передано» — по дате закрытия поставки.${snap.avgSalePrice ? ` Ср. цена продажи 7д: ${nf(snap.avgSalePrice)} ₽.` : ''}</p>
      <div class="dk-kpis">${tiles}</div>
      ${insightRow}
      <div style="margin-bottom:12px">${downloadBar(downloadHref)}</div>
      ${ph('📈', focusLabel, `${nf(delC)} шт передано`, DKAC.green)}
      ${toolbar}
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
  const statusBox = runStatus(job, active, { verb: 'Считаю движение заказов', hint: 'Страница обновится сама. Может занять 1–3 минуты.' });

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

  // #mv — якорь на блок результатов: после клика по тумблеру страница
  // перезагружается и остаётся на панели тумблеров, а не прыгает вверх.
  const nav = (patch) => {
    const v = { ...view, ...patch };
    return u(`/org/${org.id}/reports/movement?focus=${v.focus}&unit=${v.unit}&basis=${v.basis}&cost=${v.cost}&gran=${v.gran}&ov=${v.ov}&cmp=${v.cmp}&hide=${(v.hide || []).join(',')}#mv`);
  };
  const results = latest?.data
    ? movementResults(latest.data, { view, nav, downloadHref: (k) => u(`/org/${org.id}/reports/movement/download/${k}?cost=${view.cost}`), whenLabel: whenLabel(latest.createdAt) })
    : `<div class="section"><p class="muted">Данных пока нет — задайте период и нажмите «Обновить данные».</p></div>`;

  return layout({
    title: `Движение заказов — ${org.name}`, user, csrf, base, head,
    body: `<div class="wrap">${back}
      <h1>Движение заказов <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p class="kv">Кабинет: <b>${esc(active.name)}</b>. Принято на фулфилмент и передано в доставку — по дням и складам, в штуках и рублях. <a href="${u(`/org/${org.id}/reports/archive`)}">🗂 Архив запусков</a></p>
      ${statusBox}
      ${formSection}
      <div id="mv" style="scroll-margin-top:14px">${results}</div>
    </div>`,
  });
}

// ── География продаж и возвратов ─────────────────────────────────────────────
const GEO_SCOPE = { all: 'Вся РФ', moscow: 'Товары моск. FF' };
const GEO_FOCUS = { sales: 'по продажам', returns: 'по возвратам', pct: 'по % возврата' };
export function geoView(q = {}) {
  const one = (v, a, d) => (a.includes(String(v)) ? String(v) : d);
  return {
    tab: one(q.tab, ['regions', 'ff'], 'regions'),
    scope: one(q.scope, ['all', 'moscow'], 'all'),
    gran: one(q.gran, ['region', 'okrug'], 'region'),
    focus: one(q.focus, ['sales', 'returns', 'pct'], 'returns'),
  };
}

const geoSeg = (view, nav) => (lab, key, opts) => (nav ? `<div class="mv-seg"><span class="lab">${esc(lab)}</span>${opts.map((o) => `<a class="mv-chip${view[key] === o.v ? ' on' : ''}" href="${nav({ [key]: o.v })}">${esc(o.label)}</a>`).join('')}</div>` : '');

// Разрез «Регионы» — вся РФ / товары московских FF, по регионам/округам.
function geoRegions(snap, view, nav) {
  const sc = snap.scopes?.[view.scope] || { totals: {}, byRegion: [], byOkrug: [] };
  const t = sc.totals || {};
  const rows0 = (view.gran === 'okrug' ? sc.byOkrug : sc.byRegion) || [];
  const lbl = (r) => r.region || r.okrug || '—';
  const tiles = [
    dkKpi(nf(t.salesCount), 'Продаж, шт', { icon: '🛒', accent: DKAC.green }),
    dkKpi(nf(t.returnCount), 'Возвратов, шт', { icon: '↩️', accent: DKAC.red }),
    dkKpi(`${(t.returnPct || 0).toFixed(1)}%`, 'Возвратов, %', { icon: '📉', accent: DKAC.amber }),
    dkKpi(nf(t.regions), 'Регионов', { icon: '🗺️', accent: DKAC.blue }),
    dkKpi(nf(t.salesRub), 'Сумма продаж, ₽', { icon: '💰', accent: DKAC.violet }),
  ].join('');
  const bySales = [...rows0].sort((a, b) => b.salesCount - a.salesCount);
  const byRet = [...rows0].sort((a, b) => b.returnCount - a.returnCount);
  const worstPct = [...rows0].filter((r) => r.salesCount >= 20).sort((a, b) => b.returnPct - a.returnPct)[0];
  const insightRow = dkInsights([
    bySales[0] ? { icon: '🏆', accent: DKAC.green, text: `Больше всего продаж: <b>${esc(lbl(bySales[0]))}</b> — ${nf(bySales[0].salesCount)} шт` } : null,
    byRet[0] && byRet[0].returnCount ? { icon: '↩️', accent: DKAC.red, text: `Больше всего возвратов: <b>${esc(lbl(byRet[0]))}</b> — ${nf(byRet[0].returnCount)} шт` } : null,
    worstPct ? { icon: '🚩', accent: DKAC.amber, text: `Худший % возврата: <b>${esc(lbl(worstPct))}</b> — ${worstPct.returnPct}% (из ${nf(worstPct.salesCount)})` } : null,
  ]);
  const seg = geoSeg(view, nav);
  const toolbar = nav ? `<div class="mv-bar">
    ${seg('Охват', 'scope', [{ v: 'all', label: 'Вся РФ' }, { v: 'moscow', label: 'Товары моск. FF' }])}
    ${seg('Разбивка', 'gran', [{ v: 'region', label: 'Регионы' }, { v: 'okrug', label: 'Округа' }])}
    ${seg('Показатель', 'focus', [{ v: 'sales', label: 'Продажи' }, { v: 'returns', label: 'Возвраты' }, { v: 'pct', label: '% возврата' }])}
  </div>` : '';
  const metric = (r) => (view.focus === 'sales' ? r.salesCount : view.focus === 'returns' ? r.returnCount : r.returnPct);
  const color = view.focus === 'sales' ? 'var(--accent)' : view.focus === 'returns' ? 'var(--c-red)' : 'var(--c-amber)';
  const fmtM = (v) => (view.focus === 'pct' ? `${v}%` : nf(v));
  const pool = view.focus === 'pct' ? rows0.filter((r) => r.salesCount >= 20) : rows0;
  const top = [...pool].sort((a, b) => metric(b) - metric(a)).slice(0, 15);
  const mx = Math.max(1, ...top.map(metric));
  const bars = top.map((r) => { const v = metric(r); const tip = esc(JSON.stringify([{ n: lbl(r), c: color, v: fmtM(v) }])); return `<div class="geobar" data-tip="${tip}"><span class="gl" title="${esc(lbl(r))}">${esc(lbl(r))}</span><span class="gt"><span class="gf" style="width:${(v / mx * 100).toFixed(1)}%;background:${color}"></span></span><span class="gv">${fmtM(v)}</span></div>`; }).join('');
  const chart = top.length ? `<div class="geobars">${bars}</div>` : '<p class="muted">Нет данных.</p>';
  const isReg = view.gran === 'region';
  const head = `<tr>${isReg ? thT('Округ', 'Федеральный округ', 'tl') : ''}${thT(isReg ? 'Регион' : 'Округ', 'Регион покупателя', 'tl')}${thT('Продано', 'Продаж, шт', 'num')}${thT('Возвращено', 'Возвратов, шт', 'num')}${thT('% возв.', 'Возвраты к продажам', 'num')}${thT('Сумма ₽', 'Сумма продаж', 'num')}</tr>`;
  const rows = rows0.map((r) => `<tr>${isReg ? `<td class="tl kv">${esc(r.okrug)}</td>` : ''}<td class="tl">${esc(lbl(r))}</td><td class="num" data-v="${r.salesCount}">${nf(r.salesCount)}</td><td class="num" data-v="${r.returnCount}">${nf(r.returnCount)}</td><td class="num" data-v="${r.returnPct}">${r.returnPct}%</td><td class="num" data-v="${r.salesRub}">${nf(r.salesRub)}</td></tr>`).join('');
  const table = rows0.length ? `<div class="scroll"><table class="rt sortable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Нет данных за период.</p>';
  const mos = view.scope === 'moscow' ? ` Только товары московских FF (${nf(snap.moscowNmCount)} nmID со складов: ${esc((snap.moscowWarehouses || []).join(', '))}).` : '';
  return `<p class="kv" style="margin:0 0 12px">Регион покупателя из статистики WB (все продажи: FBS+FBW) за ${snap.days} дн.${mos}</p>
      <div class="dk-kpis">${tiles}</div>
      ${insightRow}
      ${ph('🗺️', `Топ-15 ${isReg ? 'регионов' : 'округов'} · ${GEO_FOCUS[view.focus]}`, GEO_SCOPE[view.scope], DKAC.blue)}
      ${toolbar}
      ${chart}
      ${ph('📋', isReg ? 'По регионам' : 'По федеральным округам', `${nf(rows0.length)} строк · клик по заголовку — сортировка`, DKAC.violet)}
      ${table}`;
}

// Разрез «По ФФ отгрузки» — FBS: возвраты привязаны к исходному складу отгрузки.
function geoFF(snap, view) {
  const f = snap.fbs || { totals: {}, byFF: [], ffByRegion: [], byDay: [], byArticle: [], unattributed: {} };
  const t = f.totals || {};
  const tiles = [
    dkKpi(nf(t.shipped), 'Отгружено, зад.', { icon: '📦', accent: DKAC.blue }),
    dkKpi(nf(t.salesCount), 'Продано (выкуп)', { icon: '🛒', accent: DKAC.green }),
    dkKpi(nf(t.returnCount), 'Возвращено', { icon: '↩️', accent: DKAC.red }),
    dkKpi(`${(t.returnPct || 0).toFixed(1)}%`, '% возврата (к выкупу)', { icon: '📉', accent: DKAC.amber }),
    dkKpi(nf((f.unattributed || {}).returnCount || 0), 'Возвраты без привязки', { icon: '❓', accent: DKAC.violet }),
  ].join('');
  const ffRet = [...(f.byFF || [])].filter((x) => x.returnCount).sort((a, b) => b.returnCount - a.returnCount);
  const worst = [...(f.byFF || [])].filter((x) => x.salesCount >= 10).sort((a, b) => b.returnPct - a.returnPct)[0];
  const ffr = [...(f.ffByRegion || [])].filter((x) => x.returnCount).sort((a, b) => b.returnCount - a.returnCount)[0];
  const insightRow = t.returnCount ? dkInsights([
    ffRet[0] ? { icon: '🏭', accent: DKAC.red, text: `Больше всего возвратов с ФФ: <b>${esc(ffRet[0].ff)}</b> — ${nf(ffRet[0].returnCount)} шт` } : null,
    worst ? { icon: '🚩', accent: DKAC.amber, text: `Худший % возврата по ФФ: <b>${esc(worst.ff)}</b> — ${worst.returnPct}%` } : null,
    ffr ? { icon: '↩️', accent: DKAC.blue, text: `Топ маршрут возврата: <b>${esc(ffr.ff)}</b> → ${esc(ffr.region)} — ${nf(ffr.returnCount)} шт` } : null,
  ]) : `<div class="dk-insights"><div class="dk-insight" style="--kc:var(--c-green)"><span class="ic">✅</span><span class="tx">За период <b>FBS-возвратов нет</b>. Привязка к ФФ отгрузки заработает автоматически при первом возврате — механизм проверен на выкупах (srid=rid, 100%).</span></div></div>`;

  const unNote = (f.unattributed || {}).returnCount ? `<div class="warn" style="margin:0 0 10px">К ФФ не привязано возвратов: <b>${nf(f.unattributed.returnCount)}</b> — их исходный заказ старше ~${snap.ordDays || 88} дней (WB хранит FBS-заказы ~3 месяца).</div>` : '';

  // По ФФ отгрузки.
  const ffHead = `<tr>${thT('ФФ отгрузки', 'Наш склад, откуда отгружен товар', 'tl')}${thT('Отгружено', 'Сборочных заданий с этого ФФ', 'num')}${thT('Выкуплено', 'Продажи (S)', 'num')}${thT('Возвращено', 'Возвраты (R)', 'num')}${thT('% возв.', 'Возвраты к выкупам', 'num')}${thT('Сумма ₽', 'Сумма выкупов', 'num')}</tr>`;
  const ffRows = (f.byFF || []).map((r) => `<tr><td class="tl">${esc(r.ff)}</td><td class="num" data-v="${r.shipped}">${nf(r.shipped)}</td><td class="num" data-v="${r.salesCount}">${nf(r.salesCount)}</td><td class="num" data-v="${r.returnCount}">${nf(r.returnCount)}</td><td class="num" data-v="${r.returnPct}">${r.returnPct}%</td><td class="num" data-v="${r.salesRub}">${nf(r.salesRub)}</td></tr>`).join('');
  const ffTable = (f.byFF || []).length ? `<div class="scroll"><table class="rt sortable"><thead>${ffHead}</thead><tbody>${ffRows}</tbody></table></div>` : '<p class="muted">Нет FBS-данных за период.</p>';

  // Матрица ФФ × регион.
  const mHead = `<tr>${thT('ФФ отгрузки', '', 'tl')}${thT('Округ', '', 'tl')}${thT('Регион покупателя', '', 'tl')}${thT('Выкуплено', '', 'num')}${thT('Возвращено', '', 'num')}${thT('% возв.', '', 'num')}</tr>`;
  const mRows = (f.ffByRegion || []).slice(0, 200).map((r) => `<tr><td class="tl">${esc(r.ff)}</td><td class="tl kv">${esc(r.okrug)}</td><td class="tl">${esc(r.region)}</td><td class="num" data-v="${r.salesCount}">${nf(r.salesCount)}</td><td class="num" data-v="${r.returnCount}">${nf(r.returnCount)}</td><td class="num" data-v="${r.returnPct}">${r.returnPct}%</td></tr>`).join('');
  const mTable = (f.ffByRegion || []).length ? `<div class="scroll"><table class="rt sortable"><thead>${mHead}</thead><tbody>${mRows}</tbody></table></div>` : '<p class="muted">Нет данных.</p>';

  // Динамика по дням (FBS).
  const bd = f.byDay || [];
  const dayChart = bd.length ? mvChart(bd.map((d) => ({ label: d.date.slice(5) })), [
    { name: 'Выкуплено', color: 'var(--accent)', values: bd.map((d) => d.salesCount) },
    { name: 'Возвраты', color: 'var(--c-red)', bold: true, values: bd.map((d) => d.returnCount) },
  ], false) + `<div class="mv-legend"><span><i style="background:var(--accent)"></i>Выкуплено</span><span><i style="background:var(--c-red)"></i>Возвраты</span></div>` : '<p class="muted">Нет данных.</p>';

  // По товарам (FBS).
  const aHead = `<tr>${thT('Артикул', '', 'tl')}${thT('Осн. ФФ', 'ФФ, откуда чаще отгружался', 'tl')}${thT('Выкуплено', '', 'num')}${thT('Возвращено', '', 'num')}${thT('% возв.', '', 'num')}${thT('Сумма ₽', '', 'num')}</tr>`;
  const aRows = (f.byArticle || []).map((r) => `<tr><td class="tl">${esc(r.article)}</td><td class="tl kv">${esc(r.ff)}</td><td class="num" data-v="${r.salesCount}">${nf(r.salesCount)}</td><td class="num" data-v="${r.returnCount}">${nf(r.returnCount)}</td><td class="num" data-v="${r.returnPct}">${r.returnPct}%</td><td class="num" data-v="${r.salesRub}">${nf(r.salesRub)}</td></tr>`).join('');
  const aTable = (f.byArticle || []).length ? `<div class="scroll"><table class="rt sortable"><thead>${aHead}</thead><tbody>${aRows}</tbody></table></div>` : '<p class="muted">Нет данных.</p>';

  return `<p class="kv" style="margin:0 0 12px">Только <b>FBS</b> (наши отгрузки). Возврат привязан к <b>исходному ФФ отгрузки</b> по номеру заказа (srid=rid). Физически возвраты приходят на московский ПВЗ; здесь видно, с какого ФФ товар изначально уехал.</p>
      <div class="dk-kpis">${tiles}</div>
      ${insightRow}
      ${unNote}
      ${ph('🏭', 'По ФФ отгрузки', 'отгружено / выкуплено / возвращено · клик по заголовку — сортировка', DKAC.blue)}
      ${ffTable}
      <div style="margin-top:22px"></div>
      ${ph('🔀', 'ФФ отгрузки × регион покупателя', `${nf((f.ffByRegion || []).length)} строк`, DKAC.violet)}
      ${mTable}
      <div style="margin-top:22px"></div>
      ${ph('📈', 'Динамика FBS по дням', 'выкупы и возвраты', DKAC.green)}
      <div class="chart-wrap">${dayChart}</div>
      <div style="margin-top:22px"></div>
      ${ph('🎨', 'По товарам (FBS)', `${nf((f.byArticle || []).length)} артикулов`, DKAC.amber)}
      ${aTable}`;
}

function geoResults(snap, { view, nav = null, downloadHref, whenLabel }) {
  const seg = geoSeg(view, nav);
  const tabBar = nav ? `<div class="mv-bar">${seg('Разрез', 'tab', [{ v: 'regions', label: 'Регионы' }, { v: 'ff', label: 'По ФФ отгрузки (FBS)' }])}</div>` : '';
  const dl = `<div style="margin-bottom:12px">${downloadBar(downloadHref)}</div>`;
  const content = view.tab === 'ff' ? geoFF(snap, view) : geoRegions(snap, view, nav);
  return `<div class="section">
      <p class="kv" style="margin:0 0 10px">Данные за ${snap.days} дн, с ${esc(snap.from || '')}.${whenLabel ? ` <b>${esc(whenLabel)}</b>` : ''}</p>
      ${dl}
      ${tabBar}
      ${content}
    </div>`;
}

export function geoPage(p) {
  const { user, csrf, base = '', org, role, active, latest, job, view, form } = p;
  const u = (path) => base + path;
  const back = `<div class="crumbs"><a href="${u(`/org/${org.id}/reports`)}">← Отчёты</a></div>`;
  if (!active) {
    return layout({ title: `География — ${org.name}`, user, csrf, base,
      body: `<div class="wrap">${back}<h1>География</h1><div class="warn">Нет активного кабинета с токеном. <a href="${u(`/org/${org.id}`)}">Настройте кабинет</a>.</div></div>` });
  }
  const running = job && job.state === 'running';
  const head = running ? '<meta http-equiv="refresh" content="4">' : '';
  const statusBox = runStatus(job, active, { verb: 'Собираю продажи, возвраты и заказы', hint: 'Статистика WB — 1 запрос/мин, может занять 1–3 минуты.' });

  const f = form;
  const formSection = `<div class="section">
    <h2>Параметры</h2>
    <form method="post" action="${u(`/org/${org.id}/reports/geo/refresh`)}">
      ${csrfField(csrf)}
      <div class="row-form" style="gap:14px;align-items:flex-end">
        <div><label for="gdays" title="За сколько последних дней брать продажи и возвраты (WB хранит ~90 дней).">Период, дней</label>
          <select id="gdays" name="days" style="width:130px">${[7, 14, 30, 60, 90].map((n) => `<option value="${n}"${Number(f.days) === n ? ' selected' : ''}>${n} дней</option>`).join('')}</select></div>
      </div>
      <button class="btn" type="submit" style="max-width:280px;margin-top:16px"${running ? ' disabled' : ''}>${running ? 'Идёт сбор…' : 'Обновить данные'}</button>
    </form></div>`;

  const nav = (patch) => { const v = { ...view, ...patch }; return u(`/org/${org.id}/reports/geo?tab=${v.tab}&scope=${v.scope}&gran=${v.gran}&focus=${v.focus}#geo`); };
  const results = latest?.data
    ? geoResults(latest.data, { view, nav, downloadHref: (k) => u(`/org/${org.id}/reports/geo/download/${k}`), whenLabel: whenLabel(latest.createdAt) })
    : `<div class="section"><p class="muted">Данных пока нет — задайте период и нажмите «Обновить данные».</p></div>`;

  return layout({
    title: `География — ${org.name}`, user, csrf, base, head,
    body: `<div class="wrap">${back}
      <h1>География продаж и возвратов <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p class="kv">Кабинет: <b>${esc(active.name)}</b>. Откуда покупают и откуда возвращают — по регионам и федеральным округам. <a href="${u(`/org/${org.id}/reports/archive`)}">🗂 Архив запусков</a></p>
      ${statusBox}
      ${formSection}
      <div id="geo" style="scroll-margin-top:14px">${results}</div>
    </div>`,
  });
}

// ── Логистика (сроки сборки и доставки по ФФ) ────────────────────────────────
export function logisticsView(q = {}) {
  const one = (v, a, d) => (a.includes(String(v)) ? String(v) : d);
  return { tab: one(q.tab, ['assembly', 'delivery'], 'assembly') };
}
const logiSeg = (view, nav) => (lab, key, opts) => (nav ? `<div class="mv-seg"><span class="lab">${esc(lab)}</span>${opts.map((o) => `<a class="mv-chip${view[key] === o.v ? ' on' : ''}" href="${nav({ [key]: o.v })}">${esc(o.label)}</a>`).join('')}</div>` : '');

// Горизонтальные бары из пар {label,value} (стиль geobars), значение — как есть.
function logiBars(items, color, fmt = nf) {
  const mx = Math.max(1, ...items.map((i) => i.value));
  const rows = items.map((i) => { const tip = esc(JSON.stringify([{ n: i.label, c: color, v: fmt(i.value) }])); return `<div class="geobar" data-tip="${tip}"><span class="gl" title="${esc(i.label)}">${esc(i.label)}</span><span class="gt"><span class="gf" style="width:${(i.value / mx * 100).toFixed(1)}%;background:${color}"></span></span><span class="gv">${fmt(i.value)}</span></div>`; }).join('');
  return items.length ? `<div class="geobars">${rows}</div>` : '<p class="muted">Нет данных.</p>';
}

// Разрез «Сборка»: createdAt → передача поставки в доставку (closedAt), по ФФ.
function logisticsAssembly(snap) {
  const a = snap.assembly || { totals: {}, byFF: [], buckets: {}, critical: [] };
  const t = a.totals || {};
  const tiles = [
    dkKpi(nf(t.processed), 'обработано заданий', { icon: '📦', accent: DKAC.blue }),
    dkKpi(fmtHrs(t.avgHours), 'среднее сборки', { icon: '⏱️', accent: DKAC.green }),
    dkKpi(fmtHrs(t.medianHours), 'медиана сборки', { icon: '📊', accent: DKAC.teal }),
    dkKpi(fmtHrs(t.p90Hours), '90-й перцентиль', { icon: '📈', accent: DKAC.violet }),
    dkKpi(nf(t.criticalCount), `критично (> ${snap.critAssemblyH || 48} ч)`, { icon: '🚨', accent: DKAC.red }),
  ].join('');
  const proc = (a.byFF || []).filter((r) => r.processed >= 5);
  const fast = [...proc].sort((x, y) => x.medianHours - y.medianHours)[0];
  const slow = [...proc].sort((x, y) => y.medianHours - x.medianHours)[0];
  const pend = (a.byFF || []).reduce((s, r) => s + (r.pending || 0), 0);
  const insightRow = dkInsights([
    fast ? { icon: '⚡', accent: DKAC.green, text: `Быстрее всех собирает: <b>${esc(fast.ff)}</b> — медиана ${fmtHrs(fast.medianHours)}` } : null,
    slow && slow !== fast ? { icon: '🐢', accent: DKAC.amber, text: `Медленнее всех: <b>${esc(slow.ff)}</b> — медиана ${fmtHrs(slow.medianHours)}` } : null,
    pend ? { icon: '⏳', accent: DKAC.blue, text: `Ещё не отгружено: <b>${nf(pend)}</b> заданий` } : { icon: '✅', accent: DKAC.green, text: 'Все задания периода отгружены' },
  ]);
  const buckets = Object.entries(a.buckets || {}).map(([k, v]) => ({ label: k, value: v }));
  const head = `<tr>${thT('ФФ отгрузки', 'Наш склад-фулфилмент, где собирают заказ', 'tl')}${thT('Сделано', 'Сборочных заданий за период', 'num')}${thT('Обраб.', 'Передано в доставку (собрано)', 'num')}${thT('В работе', 'Ещё не отгружено', 'num')}${thT('Среднее', 'Среднее время сборки', 'num')}${thT('Медиана', 'Медианное время сборки', 'num')}${thT('p90', '90-й перцентиль', 'num')}${thT('Макс', 'Максимум', 'num')}${thT('Крит.', `Дольше ${snap.critAssemblyH || 48} ч`, 'num')}</tr>`;
  const rows = (a.byFF || []).map((r) => `<tr><td class="tl">${esc(r.ff)}</td><td class="num" data-v="${r.made}">${nf(r.made)}</td><td class="num" data-v="${r.processed}">${nf(r.processed)}</td><td class="num" data-v="${r.pending}">${nf(r.pending)}</td><td class="num" data-v="${r.avgHours}">${fmtHrs(r.avgHours)}</td><td class="num" data-v="${r.medianHours}">${fmtHrs(r.medianHours)}</td><td class="num" data-v="${r.p90Hours}">${fmtHrs(r.p90Hours)}</td><td class="num" data-v="${r.maxHours}">${fmtHrs(r.maxHours)}</td><td class="num" data-v="${r.criticalCount}">${nf(r.criticalCount)}</td></tr>`).join('');
  const table = (a.byFF || []).length ? `<div class="scroll"><table class="rt sortable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Нет данных за период.</p>';
  const crit = (a.critical || []).slice(0, 15);
  const critTable = crit.length ? `${ph('🚨', 'Самые долгие сборки', `дольше ${snap.critAssemblyH || 48} ч`, DKAC.red)}
    <div class="scroll"><table class="rt sortable"><thead><tr>${thT('ФФ', '', 'tl')}${thT('Артикул', '', 'tl')}${thT('Время сборки', '', 'num')}${thT('Создан', '', 'tl')}${thT('Отгружен', '', 'tl')}</tr></thead><tbody>${crit.map((c) => `<tr><td class="tl">${esc(c.ff)}</td><td class="tl">${esc(c.article)}</td><td class="num" data-v="${c.hours}">${fmtHrs(c.hours)}</td><td class="tl kv">${esc(String(c.createdAt).slice(0, 16).replace('T', ' '))}</td><td class="tl kv">${esc(String(c.closedAt).slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<p class="kv" style="margin:0 0 12px">Время сборки = от создания сборочного задания до передачи поставки в доставку (createdAt → closedAt), по нашему складу-фулфилменту. За ${snap.days} дн.</p>
      <div class="dk-kpis">${tiles}</div>
      ${insightRow}
      ${ph('🏭', 'Сроки сборки по ФФ', 'среднее / медиана / p90 · клик по заголовку — сортировка', DKAC.blue)}
      ${table}
      <div style="margin-top:22px"></div>
      ${ph('⏱️', 'Распределение по времени сборки', 'сколько заданий в каждом интервале', DKAC.teal)}
      ${logiBars(buckets, 'var(--accent)', nf)}
      ${critTable ? `<div style="margin-top:22px"></div>${critTable}` : ''}`;
}

// Разрез «Доставка»: closedAt → sale.date (выкуп), по ФФ отгрузки и региону.
function logisticsDelivery(snap) {
  const d = snap.delivery || { available: false, totals: {}, byFF: [], byRegion: [], buckets: {}, byDay: [] };
  const t = d.totals || {};
  if (!d.available) {
    return `<div class="dk-insights"><div class="dk-insight" style="--kc:var(--c-green)"><span class="ic">✅</span><span class="tx">За период нет выкупов FBS, привязанных к ФФ отгрузки, — скорость доставки появится автоматически при первых продажах. Механизм привязки проверен (srid = rid, 100%).</span></div></div>`;
  }
  const tiles = [
    dkKpi(nf(t.count), 'выкупов измерено', { icon: '📬', accent: DKAC.green }),
    dkKpi(fmtHrs(t.avgHours), 'среднее доставки', { icon: '🚚', accent: DKAC.blue }),
    dkKpi(fmtHrs(t.medianHours), 'медиана доставки', { icon: '📊', accent: DKAC.teal }),
    dkKpi(fmtHrs(t.p90Hours), '90-й перцентиль', { icon: '📈', accent: DKAC.violet }),
  ].join('');
  const ffP = (d.byFF || []).filter((r) => r.count >= 5);
  const fastFF = [...ffP].sort((x, y) => x.medianHours - y.medianHours)[0];
  const regP = (d.byRegion || []).filter((r) => r.count >= 5);
  const fastReg = [...regP].sort((x, y) => x.medianHours - y.medianHours)[0];
  const slowReg = [...regP].sort((x, y) => y.medianHours - x.medianHours)[0];
  const insightRow = dkInsights([
    fastFF ? { icon: '⚡', accent: DKAC.green, text: `Быстрее всех доставляет: <b>${esc(fastFF.ff)}</b> — медиана ${fmtHrs(fastFF.medianHours)}` } : null,
    fastReg ? { icon: '🏆', accent: DKAC.blue, text: `Быстрее всех регион: <b>${esc(fastReg.region)}</b> — ${fmtHrs(fastReg.medianHours)}` } : null,
    slowReg && slowReg !== fastReg ? { icon: '🐢', accent: DKAC.amber, text: `Дольше всех регион: <b>${esc(slowReg.region)}</b> — ${fmtHrs(slowReg.medianHours)}` } : null,
  ]);
  const buckets = Object.entries(d.buckets || {}).map(([k, v]) => ({ label: k, value: v }));
  const ffHead = `<tr>${thT('ФФ отгрузки', 'С какого нашего склада уехал товар', 'tl')}${thT('Выкупов', 'Сколько доставок измерено', 'num')}${thT('Среднее', 'Среднее время доставки', 'num')}${thT('Медиана', 'Медианное время', 'num')}${thT('p90', '90-й перцентиль', 'num')}${thT('Мин', '', 'num')}${thT('Макс', '', 'num')}</tr>`;
  const ffRows = (d.byFF || []).map((r) => `<tr><td class="tl">${esc(r.ff)}</td><td class="num" data-v="${r.count}">${nf(r.count)}</td><td class="num" data-v="${r.avgHours}">${fmtHrs(r.avgHours)}</td><td class="num" data-v="${r.medianHours}">${fmtHrs(r.medianHours)}</td><td class="num" data-v="${r.p90Hours}">${fmtHrs(r.p90Hours)}</td><td class="num" data-v="${r.minHours}">${fmtHrs(r.minHours)}</td><td class="num" data-v="${r.maxHours}">${fmtHrs(r.maxHours)}</td></tr>`).join('');
  const ffTable = (d.byFF || []).length ? `<div class="scroll"><table class="rt sortable"><thead>${ffHead}</thead><tbody>${ffRows}</tbody></table></div>` : '<p class="muted">Нет данных.</p>';
  const bd = d.byDay || [];
  const dayChart = bd.length ? mvChart(bd.map((x) => ({ label: x.date.slice(5) })), [
    { name: 'Среднее, ч', color: 'var(--accent)', bold: true, values: bd.map((x) => x.avgHours) },
  ], false) + `<div class="mv-legend"><span><i style="background:var(--accent)"></i>Среднее время доставки, ч (по дню отгрузки)</span></div>` : '<p class="muted">Нет данных.</p>';
  const rHead = `<tr>${thT('Округ', '', 'tl')}${thT('Регион покупателя', '', 'tl')}${thT('Выкупов', '', 'num')}${thT('Среднее', 'Среднее время доставки', 'num')}${thT('Медиана', '', 'num')}</tr>`;
  const rRows = (d.byRegion || []).slice(0, 200).map((r) => `<tr><td class="tl kv">${esc(r.okrug)}</td><td class="tl">${esc(r.region)}</td><td class="num" data-v="${r.count}">${nf(r.count)}</td><td class="num" data-v="${r.avgHours}">${fmtHrs(r.avgHours)}</td><td class="num" data-v="${r.medianHours}">${fmtHrs(r.medianHours)}</td></tr>`).join('');
  const rTable = (d.byRegion || []).length ? `<div class="scroll"><table class="rt sortable"><thead>${rHead}</thead><tbody>${rRows}</tbody></table></div>` : '<p class="muted">Нет данных.</p>';
  return `<p class="kv" style="margin:0 0 12px">Скорость доставки = от передачи поставки в доставку (уход с ФФ) до выкупа клиентом (closedAt → дата продажи из статистики WB). Выкуп привязан к <b>исходному ФФ отгрузки</b> по номеру заказа (srid = rid). Включает межскладскую и последнюю милю WB. За ${snap.days} дн.</p>
      <div class="dk-kpis">${tiles}</div>
      ${insightRow}
      ${ph('🚚', 'Скорость доставки по ФФ отгрузки', 'ФФ → конечный клиент · клик по заголовку — сортировка', DKAC.blue)}
      ${ffTable}
      <div style="margin-top:22px"></div>
      ${ph('⏱️', 'Распределение по времени доставки', 'сколько выкупов в каждом интервале (в сутках)', DKAC.teal)}
      ${logiBars(buckets, 'var(--c-teal)', nf)}
      <div style="margin-top:22px"></div>
      ${ph('📈', 'Динамика по дням отгрузки', 'среднее время доставки, ч', DKAC.green)}
      <div class="chart-wrap">${dayChart}</div>
      <div style="margin-top:22px"></div>
      ${ph('🗺️', 'Скорость доставки по регионам покупателя', `${nf((d.byRegion || []).length)} регионов`, DKAC.violet)}
      ${rTable}`;
}

function logisticsResults(snap, { view, nav = null, downloadHref, whenLabel }) {
  const seg = logiSeg(view, nav);
  const tabBar = nav ? `<div class="mv-bar">${seg('Разрез', 'tab', [{ v: 'assembly', label: 'Сборка' }, { v: 'delivery', label: 'Доставка' }])}</div>` : '';
  const dl = `<div style="margin-bottom:12px">${downloadBar(downloadHref)}</div>`;
  const content = view.tab === 'delivery' ? logisticsDelivery(snap) : logisticsAssembly(snap);
  return `<div class="section">
      <p class="kv" style="margin:0 0 10px">Данные за ${snap.days} дн, с ${esc(snap.from || '')}.${whenLabel ? ` <b>${esc(whenLabel)}</b>` : ''}</p>
      ${dl}
      ${tabBar}
      ${content}
    </div>`;
}

export function logisticsPage(p) {
  const { user, csrf, base = '', org, role, active, latest, job, view, form } = p;
  const u = (path) => base + path;
  const back = `<div class="crumbs"><a href="${u(`/org/${org.id}/reports`)}">← Отчёты</a></div>`;
  if (!active) {
    return layout({ title: `Логистика — ${org.name}`, user, csrf, base,
      body: `<div class="wrap">${back}<h1>Логистика</h1><div class="warn">Нет активного кабинета с токеном. <a href="${u(`/org/${org.id}`)}">Настройте кабинет</a>.</div></div>` });
  }
  const running = job && job.state === 'running';
  const head = running ? '<meta http-equiv="refresh" content="4">' : '';
  const statusBox = runStatus(job, active, { verb: 'Считаю сроки сборки и доставки', hint: 'Статистика WB — 1 запрос/мин, может занять 1–3 минуты.' });

  const f = form;
  const formSection = `<div class="section">
    <h2>Параметры</h2>
    <form method="post" action="${u(`/org/${org.id}/reports/logistics/refresh`)}">
      ${csrfField(csrf)}
      <div class="row-form" style="gap:14px;align-items:flex-end">
        <div><label for="ldays" title="За сколько последних дней считать сроки сборки и доставки (WB хранит статистику ~90 дней).">Период, дней</label>
          <select id="ldays" name="days" style="width:130px">${[7, 14, 30, 60, 90].map((n) => `<option value="${n}"${Number(f.days) === n ? ' selected' : ''}>${n} дней</option>`).join('')}</select></div>
      </div>
      <button class="btn" type="submit" style="max-width:280px;margin-top:16px"${running ? ' disabled' : ''}>${running ? 'Идёт сбор…' : 'Обновить данные'}</button>
    </form></div>`;

  const nav = (patch) => { const v = { ...view, ...patch }; return u(`/org/${org.id}/reports/logistics?tab=${v.tab}#logi`); };
  const results = latest?.data
    ? logisticsResults(latest.data, { view, nav, downloadHref: (k) => u(`/org/${org.id}/reports/logistics/download/${k}`), whenLabel: whenLabel(latest.createdAt) })
    : `<div class="section"><p class="muted">Данных пока нет — задайте период и нажмите «Обновить данные».</p></div>`;

  return layout({
    title: `Логистика — ${org.name}`, user, csrf, base, head,
    body: `<div class="wrap">${back}
      <h1>Логистика — сроки сборки и доставки <span class="badge ${esc(role)}">${esc(roleRu(role))}</span></h1>
      <p class="kv">Кабинет: <b>${esc(active.name)}</b>. Среднее время сборки по каждому ФФ и скорость доставки от фулфилмента до конечного клиента. <a href="${u(`/org/${org.id}/reports/archive`)}">🗂 Архив запусков</a></p>
      ${statusBox}
      ${formSection}
      <div id="logi" style="scroll-margin-top:14px">${results}</div>
    </div>`,
  });
}

// ── Архив отчётов компании: список запусков ─────────────────────────────────
export function archivePage({ user, csrf, base = '', org, role, runs, report = '', types = [] }) {
  const u = (p) => base + p;
  const dt = (v) => esc(String(v || '').slice(0, 16).replace('T', ' ')) + ' UTC';
  const filter = types.length > 1 ? `<form method="get" action="${u(`/org/${org.id}/reports/archive`)}" style="margin:0 0 12px">
      <label class="kv" title="Показать в архиве только выбранный тип отчёта" style="margin-right:8px">Тип отчёта:</label>
      <select name="report" style="max-width:240px" onchange="this.form.submit()">
        <option value=""${report ? '' : ' selected'}>Все отчёты</option>
        ${types.map((t) => `<option value="${esc(t)}"${report === t ? ' selected' : ''}>${esc(reportRu(t))}</option>`).join('')}
      </select> <noscript><button class="btn btn-sm" type="submit">Показать</button></noscript>
    </form>` : '';
  const summ = (r) => {
    const sm = r.summary || {};
    if (r.report === 'stock') return `остаток ${nf(sm.grandTotal)} шт · складов ${nf(sm.activeWarehouses)} · арт+цвет ${nf(sm.articleCount)}`;
    if (r.report === 'movement') return `принято ${nf(sm.acceptedTotal)} · передано ${nf(sm.deliveredTotal)} · Δ ${sm.diffTotal >= 0 ? '+' : ''}${nf(sm.diffTotal)} · ${nf(sm.deliveredMoney)} ₽ (${nf(sm.days)} дн)`;
    if (r.report === 'geo') return `продаж ${nf(sm.salesCount)} · возвратов ${nf(sm.returnCount)} (${sm.returnPct}%) · регионов ${nf(sm.regions)} (${nf(sm.days)} дн)`;
    if (r.report === 'logistics') return `сборка медиана ${fmtHrs(sm.asmMedianHours)} (${nf(sm.asmProcessed)}) · доставка медиана ${fmtHrs(sm.delMedianHours)} (${nf(sm.delCount)}) (${nf(sm.days)} дн)`;
    return `подсорт ${nf(sm.reorderUnits)} · риск ${nf(sm.riskRows)} · завоз ${nf(sm.seedUnits)}${(sm.articles && sm.articles.length) ? ` · арт: ${esc(sm.articles.join(', '))}` : ''}`;
  };
  // Кто может удалить конкретный запуск: автор — свой; владелец — любой авторский.
  // Накопительный по расписанию (authorId == null) не удаляется ни у кого.
  const canDelete = (r) => r.authorId != null && (r.authorId === user.id || role === 'owner');
  const dlLink = (r, kind, label, extra = '') => `<a class="dl" style="padding:5px 9px;font-size:12px;margin:${extra}" href="${u(`/org/${org.id}/reports/archive/${r.id}/download/${kind}`)}">${label}</a>`;
  const rows = (runs || []).map((r) => {
    const who = r.authorId == null ? '<span class="pill">по расписанию</span>' : esc(r.userEmail || '—');
    return `<tr>
      <td class="tl"><a href="${u(`/org/${org.id}/reports/archive/${r.id}`)}">${dt(r.createdAt)}</a></td>
      <td>${esc(reportRu(r.report))}</td>
      <td class="tl kv">${who}</td>
      <td class="tl kv">${summ(r)}</td>
      <td style="text-align:right;white-space:nowrap">
        ${dlLink(r, 'html', 'HTML', '0 4px 0 0')}
        ${dlLink(r, 'xlsx', 'Excel', '0 4px 0 0')}
        ${dlLink(r, 'json', 'JSON', '0')}
        ${canDelete(r) ? formBtn(csrf, u(`/org/${org.id}/reports/archive/${r.id}/delete`), 'Удалить', 'mini btn-danger', 'Удалить этот отчёт из архива? Отменить нельзя.') : ''}
      </td>
    </tr>`;
  }).join('');
  // Массовая очистка: владелец — все авторские запуски; остальные — только свои.
  // Накопительные по расписанию не в счёт (их нельзя удалить).
  const clearable = (runs || []).filter(canDelete).length;
  const clearBtn = clearable ? formBtn(
    csrf, u(`/org/${org.id}/reports/archive/clear`),
    role === 'owner' ? `Очистить все отчёты (${clearable})` : `Очистить мои отчёты (${clearable})`,
    'btn-sm btn-danger',
    role === 'owner'
      ? 'Удалить ВСЕ отчёты компании из архива? Накопительные снимки по расписанию сохранятся. Отменить нельзя.'
      : 'Удалить ВСЕ ваши отчёты из архива? Отменить нельзя.',
  ) : '';
  return layout({
    title: `Архив отчётов — ${org.name}`, user, csrf, base,
    body: `<div class="wrap">
      <div class="crumbs"><a href="${u(`/org/${org.id}/reports`)}">← Отчёты</a></div>
      <h1>Архив отчётов</h1>
      <p class="sub">История запусков компании (хранится 90 дней). Откройте запуск, чтобы посмотреть или скачать (HTML / Excel / JSON). Свой запуск может удалить автор, любой авторский — владелец компании. Накопительные снимки по расписанию (помечены «по расписанию») не удаляются.</p>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 12px">${filter}${clearBtn}</div>
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
  const when = esc(whenLabel(run.createdAt));
  const dl = (k) => u(`/org/${org.id}/reports/archive/${run.id}/download/${k}`);
  const body = !run.data
    ? '<div class="section"><p class="muted">Не удалось прочитать снимок этого запуска.</p></div>'
    : run.report === 'stock'
      ? stockResults(run.data, { downloadHref: dl, whenLabel: '' })
      : run.report === 'movement'
        ? movementResults(run.data, { view: movementView({}), nav: null, downloadHref: dl, whenLabel: '' })
        : run.report === 'geo'
          ? geoResults(run.data, { view: geoView({}), nav: null, downloadHref: dl, whenLabel: '' })
          : run.report === 'logistics'
            ? logisticsResults(run.data, { view: logisticsView({}), nav: null, downloadHref: dl, whenLabel: '' })
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
