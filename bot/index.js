// bot/index.js — точка входа Telegram-бота (grammY).
//
// Меню из реестра → сбор формы → подтверждение → выполнение (очередь+CLI) →
// готовый прогон: выбор формата (HTML/PDF/XLSX) и пикер конкурентов (2–4).

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Bot, InputFile, InlineKeyboard, session, GrammyError, HttpError } from 'grammy';
import {
  openDb, createRun, updateRun, finishRun, getRun,
  saveReportFile, getReportFile, saveArtifact, getArtifact,
  cacheGet, cachePut,
} from '../lib/db.js';
import { runCardsComparison } from '../lib/wbCardsCompare.js';
import { checkOwnArticle } from '../lib/wbOwnCards.js';
import { loadRegistry, menuItems } from './core/registry.js';
import { sqliteStorage } from './core/session-store.js';
import { Queue } from './core/queue.js';
import { runCli, tail } from './core/executor.js';
import { renderReport } from './render/index.js';
import * as fsm from './core/fsm.js';
import * as kb from './core/keyboards.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = path.join(ROOT, 'reports-output', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Нет TELEGRAM_BOT_TOKEN. Задайте в .env или env среды.');
  process.exit(1);
}

const db = openDb();
const registry = await loadRegistry();
const admins = new Set(
  (process.env.BOT_ADMINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const isAdmin = (ctx) => admins.has(String(ctx.from?.id));

const bot = new Bot(token);
const queue = new Queue({ concurrency: 2 });
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));

bot.use(
  session({
    initial: () => ({ flow: null }),
    storage: sqliteStorage(db),
    getSessionKey: (ctx) => (ctx.chat?.id != null ? String(ctx.chat.id) : undefined),
  })
);

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const manifestOf = (id) => registry.get(id);

/** Показывает текущий экран диалога (новым сообщением). */
async function showScreen(ctx, manifest, flow) {
  const screen = fsm.screenFor(manifest, flow);
  if (screen.type === 'ask') {
    const f = screen.field;
    if (f.type === 'choice') {
      await ctx.reply(`${f.label}?`, { reply_markup: kb.choiceKeyboard(f) });
    } else if (f.type === 'boolean') {
      await ctx.reply(`${f.label}?`, { reply_markup: kb.booleanKeyboard(f) });
    } else {
      fsm.setAsking(manifest, flow, f.key);
      const extra = [f.hint, f.placeholder].filter(Boolean).join(' · ');
      await ctx.reply(`Введите: <b>${esc(f.label)}</b>${extra ? `\n<i>${esc(extra)}</i>` : ''}`, {
        parse_mode: 'HTML',
      });
    }
    return;
  }
  if (screen.type === 'advanced_offer') {
    await ctx.reply('Обязательные поля заполнены. Настроить дополнительные фильтры?', {
      reply_markup: kb.advancedOfferKeyboard(),
    });
    return;
  }
  if (screen.type === 'advanced_menu') {
    await ctx.reply('Дополнительные фильтры — выберите поле или «Готово»:', {
      reply_markup: kb.advancedMenuKeyboard(manifest, flow),
    });
    return;
  }
  // confirm
  const lines = screen.summary.map((s) => `• <b>${esc(s.label)}</b>: ${esc(s.value)}`).join('\n');
  await ctx.reply(`<b>${esc(manifest.title)}</b>\n\n${lines || '<i>без параметров</i>'}\n\nЗапустить?`, {
    parse_mode: 'HTML',
    reply_markup: kb.confirmKeyboard(),
  });
}

async function showMenu(ctx) {
  const items = menuItems(registry, { isAdmin: isAdmin(ctx) });
  if (!items.length) return ctx.reply('Пока нет доступных скиллов.');
  const list = items.map((i) => `• <b>${esc(i.title)}</b> — ${esc(i.description)}`).join('\n');
  await ctx.reply(`Доступные отчёты:\n\n${list}\n\nВыберите:`, {
    parse_mode: 'HTML',
    reply_markup: kb.menuKeyboard(items),
  });
}

// ─────────────── выполнение (очередь + выдача) ───────────────

/** Ставит прогон скилла в очередь: CLI-шаг → результат в чат владельца. */
function enqueueRun({ manifest, runId, chatId, params }) {
  const step = (manifest.steps || []).find((s) => s.executor === 'cli' && typeof s.buildArgv === 'function');
  const outJson = path.join(RUNS_DIR, `run-${runId}.json`);
  const argv = step.buildArgv(params, { outJson });
  queue.enqueue(
    async () => {
      updateRun(db, runId, { status: 'running', startedAt: new Date().toISOString() });
      const res = await runCli({ npmScript: manifest.npmScript, argv, cwd: ROOT, outJson });
      if (!res.ok) {
        const msg = tail(res.stderr || res.stdout || `код ${res.code}`, 500);
        finishRun(db, runId, { error: msg });
        await bot.api
          .sendMessage(chatId, `❌ Задача #${runId}: не удалось выполнить.\n<code>${esc(msg)}</code>`, {
            parse_mode: 'HTML',
          })
          .catch(() => {});
        return;
      }
      // прогон готов: держим статус awaiting_user, показываем сводку + действия
      updateRun(db, runId, { status: 'awaiting_user', result: res.data, finishedAt: new Date().toISOString() });
      await deliverResult({ manifest, runId, chatId, data: res.data, outJson }).catch(async (e) => {
        await bot.api
          .sendMessage(chatId, `⚠️ Задача #${runId} выполнена, но выдача не удалась: ${esc(e.message)}`)
          .catch(() => {});
      });
    },
    { lane: manifest.cache?.source || manifest.id }
  );
}

/** Выдаёт результат в чат: текстовая сводка + JSON-контракт файлом. */
async function deliverResult({ manifest, runId, chatId, data, outJson }) {
  const rivals = Array.isArray(data?.rivals) ? data.rivals : [];
  const per = data?.period ? `${data.period.d1}…${data.period.d2}` : '';
  const head =
    `✅ <b>#${runId} · ${esc(manifest.title)}</b>\n` +
    `Фраза: «${esc(data?.query || '')}»${per ? ` · период ${esc(per)}` : ''}\n` +
    `Найдено конкурентов: <b>${rivals.length}</b>${data?.total ? ` (из выдачи ${data.total})` : ''}` +
    (data?.searchFromCache ? ' · <i>выдача из кэша</i>' : '');
  // Воронка отсева: где и сколько отсеялось (прозрачность агрессивности фильтров).
  let funnelLine = '';
  if (data?.funnel) {
    const f = data.funnel;
    const parts = [`&lt;100k₽ −${f.belowRevenue}`];
    if (f.byMetrics) parts.push(`метрики −${f.byMetrics}`);
    if (f.byExclude) parts.push(`исключения −${f.byExclude}`);
    for (const [label, n] of Object.entries(f.byFacet || {})) parts.push(`${esc(label)} −${n}`);
    if (f.byGroup) parts.push(`не по группам −${f.byGroup}`);
    funnelLine = `\n\n📉 <b>Воронка:</b> ${f.fetched} → ${parts.join(' · ')} → <b>${f.kept}</b>`;
  }
  const lines = rivals.slice(0, 10).map((r, i) => {
    const name = String(r.name || '').slice(0, 60);
    const mark = r.patternUncertain ? '🟡 ' : '';
    return (
      `${i + 1}. ${mark}<code>${esc(r.nmId)}</code> · ${esc(r.brand || '—')} — ${fmt(r.price)}₽ · выручка ${fmt(r.revenue)}₽\n` +
      `   <i>${esc(name)}</i>`
    );
  });
  const uncertain = rivals.filter((r) => r.patternUncertain).length;
  const uncNote = uncertain ? `\n🟡 у ${uncertain} карточек рисунок не определён — проверьте визуально.` : '';
  const more =
    (rivals.length > 10
      ? `\n\n… ещё ${rivals.length - 10}. Скачать полный отчёт в нужном формате:`
      : '\n\nСкачать отчёт:') + uncNote;
  await bot.api.sendMessage(chatId, `${head}${funnelLine}\n\n${lines.join('\n')}${more}`, {
    parse_mode: 'HTML',
    reply_markup: kb.resultActionsKeyboard(runId, manifest.formats || ['html', 'pdf', 'xlsx']),
  });
}

/** Рендерит формат (с кэшем в report_files/skill_artifacts) и шлёт документом. */
async function deliverFormat({ runId, chatId, format }) {
  const run = getRun(db, runId);
  if (!run || !run.result) {
    return bot.api.sendMessage(chatId, `Задача #${runId}: данные недоступны. Запустите заново — /skills.`);
  }
  const manifest = registry.get(run.skill);
  const cached = getArtifact(db, runId, format);
  if (cached?.file_id) {
    const f = getReportFile(db, cached.file_id);
    if (f) {
      return bot.api.sendDocument(chatId, new InputFile(Buffer.from(f.bytes), f.filename), {
        caption: `#${runId} · ${format.toUpperCase()} (из кэша)`,
      });
    }
  }
  const wait = await bot.api.sendMessage(chatId, `⏳ Готовлю ${format.toUpperCase()}…`);
  try {
    const images = run.params?.images !== false;
    const { path: outPath, filename, mime } = await renderReport({
      skill: run.skill,
      format,
      data: run.result,
      outDir: RUNS_DIR,
      runId,
      images: format === 'xlsx' ? false : images,
    });
    const bytes = fs.readFileSync(outPath);
    const fileId = saveReportFile(db, { source: `bot.${run.skill}`, entity: String(runId), filename, mime, bytes });
    saveArtifact(db, runId, format, fileId);
    await bot.api.sendDocument(chatId, new InputFile(outPath, filename), {
      caption: `#${runId} · ${esc(manifest?.title || run.skill)} · ${format.toUpperCase()}`,
    });
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ Не удалось собрать ${format.toUpperCase()}: ${esc(e.message)}`);
  } finally {
    await bot.api.deleteMessage(chatId, wait.message_id).catch(() => {});
  }
}

/** Множество выбранных nmId прогона (из result._selected). */
function selectedSet(run) {
  return new Set((run?.result?._selected || []).map(String));
}
function saveSelected(runId, run, set) {
  updateRun(db, runId, { result: { ...run.result, _selected: [...set] } });
}

/** Скачивает миниатюру карточки (Telegram не может забрать webp с CDN WB сам). */
async function fetchThumb(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Фото-пикер: топ-N конкурентов, каждый — фото с тумблером ⬜/✅ под ним, затем «Готово».
 * Фото шлём БАЙТАМИ (webp по URL Telegram не принимает; байты — принимает).
 */
async function sendPhotoPicker(chatId, runId, rivals, sel, { min, max, topN = 12 } = {}) {
  const list = rivals.slice(0, topN);
  await bot.api.sendMessage(
    chatId,
    `🎯 Отметьте <b>${min}–${max}</b> конкурента тумблером под их фото, затем «Готово». Показаны топ-${list.length}.`,
    { parse_mode: 'HTML' }
  );
  // качаем миниатюры параллельно, шлём по порядку (сохранить нумерацию)
  const bufs = await Promise.all(list.map((r) => (r.thumb ? fetchThumb(r.thumb) : Promise.resolve(null))));
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const cap =
      `${i + 1}. ${r.patternUncertain ? '🟡 ' : ''}<b>${esc(r.brand || '—')}</b> · ${fmt(r.price)}₽ · выручка ${fmt(r.revenue)}₽\n` +
      `<i>${esc(String(r.name || '').slice(0, 80))}</i>\nnmId <code>${esc(r.nmId)}</code>`;
    const markup = kb.photoToggleKeyboard(runId, i, sel.has(String(r.nmId)));
    try {
      if (bufs[i]) {
        await bot.api.sendPhoto(chatId, new InputFile(bufs[i], `${r.nmId}.webp`), {
          caption: cap,
          parse_mode: 'HTML',
          reply_markup: markup,
        });
      } else {
        await bot.api.sendMessage(chatId, cap, { parse_mode: 'HTML', reply_markup: markup });
      }
    } catch {
      await bot.api.sendMessage(chatId, cap, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
    }
  }
  await bot.api.sendMessage(chatId, 'Отметили — жмите:', { reply_markup: kb.pickDoneKeyboard(runId) });
}

// ─────────────── «Сравнение карточек» (кабинет WB, кастомный исполнитель) ───────────────

/** Кэш множества наших nmID поверх source_cache (рантайм-БД, эфемерный). */
function ownCache() {
  return {
    get: (k) => cacheGet(db, 'wb.own-cards', { k })?.payload,
    set: (k, v) => cachePut(db, { source: 'wb.own-cards', key: { k }, payload: v }),
  };
}

const parseRivalsText = (raw) =>
  String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,}$/.test(s));

/** SESSION_EXPIRED и прочие ошибки кабинета — в понятное сообщение. */
async function ccError(chatId, runId, e) {
  const msg = String(e?.message || e);
  if (msg.includes('SESSION_EXPIRED')) {
    return bot.api
      .sendMessage(
        chatId,
        `🔑 Сессия кабинета WB истекла (#${runId}). Нужны свежие креды кабинета ` +
          `(куки + localStorage). Обновите WB_COOKIES / WB_LOCALSTORAGE и повторите.`
      )
      .catch(() => {});
  }
  return bot.api.sendMessage(chatId, `❌ Сравнение #${runId}: ${esc(msg.slice(0, 400))}`).catch(() => {});
}

/** Старт: валидация → гейт «наш/не наш» → DRY-RUN (скрин) → подтверждение. */
async function startCardsCompare({ manifest, chatId, telegramId, params }) {
  const our = String(params.our);
  const rivals = parseRivalsText(params.rivals);
  if (rivals.length < 2 || rivals.length > 4) {
    return bot.api.sendMessage(
      chatId,
      `Нужно 2–4 конкурента (распознано ${rivals.length}). Повторите — /skills.`
    );
  }

  // Гейт: наш ли артикул (Content API — лимит сравнений НЕ тратит).
  await bot.api.sendMessage(chatId, `🔎 Проверяю, ваш ли артикул <code>${esc(our)}</code>…`, {
    parse_mode: 'HTML',
  });
  let ownership;
  try {
    ownership = await checkOwnArticle(our, { cache: ownCache() });
  } catch (e) {
    return bot.api.sendMessage(chatId, `⚠️ Не удалось проверить принадлежность: ${esc(e.message)}`);
  }
  if (!ownership.ours) {
    return bot.api.sendMessage(
      chatId,
      `🚫 Артикул <code>${esc(our)}</code> не найден в вашем кабинете (сверено с ${ownership.total} вашими карточками).\n\n` +
        `«Сравнение карточек» строит воронку «ваш vs конкуренты», а её WB отдаёт только по своим карточкам. ` +
        `Лимит не потрачен. Укажите свой артикул, или используйте «🔍 Конкуренты по запросу» для списка конкурентов.`,
      { parse_mode: 'HTML' }
    );
  }

  // Наш → текстовое подтверждение (БЕЗ отдельного DRY-RUN браузера). Одна сессия
  // на submit надёжнее двухфазной схемы, где состояние между двумя браузерами хрупко
  // (падения «5 из 5»/«page closed»). Гейт + список + подтверждение защищают лимит.
  const { id: runId } = createRun(db, {
    telegramId,
    skill: manifest.id,
    params: { our, rivals },
    status: 'awaiting_user',
  });
  const markup = new InlineKeyboard()
    .text('🚀 Подтвердить (−1 сравнение)', `ccok:${runId}`)
    .row()
    .text('✖ Отмена', `cccancel:${runId}`);
  await bot.api.sendMessage(
    chatId,
    `✅ Артикул ваш. Сравнить: ваш <code>${esc(our)}</code> + ${rivals.length} конкурентов ` +
      `(<code>${rivals.map(esc).join('</code>, <code>')}</code>).\n` +
      `Запуск потратит <b>1 сравнение</b> из месячного лимита. Подтвердите:`,
    { parse_mode: 'HTML', reply_markup: markup }
  );
}

/** Подтверждено: submit (тратит лимит) → XLSX + данные в БД (72 ч) → выдача. */
async function runCcSubmit({ runId, chatId }) {
  const run = getRun(db, runId);
  if (!run || !run.params) return;
  const { our, rivals } = run.params;
  await bot.api.sendMessage(chatId, `⏳ Выполняю сравнение #${runId} (тратит 1 сравнение)…`);
  queue.enqueue(
    async () => {
      updateRun(db, runId, { status: 'running' });
      const out = path.join(RUNS_DIR, `cards-compare-${runId}.xlsx`);
      // Сохранить XLSX в БД + отдать документом. Общий хвост для успеха и восстановления.
      const deliver = async (res, note) => {
        let fileId = null;
        if (res?.out && fs.existsSync(res.out)) {
          const bytes = fs.readFileSync(res.out);
          fileId = saveReportFile(db, {
            source: 'wb.cards-compare',
            entity: String(our),
            filename: `сравнение-${our}.xlsx`,
            mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            bytes,
          });
          saveArtifact(db, runId, 'xlsx', fileId);
        }
        finishRun(db, runId, { result: { our, rivals, data: res?.data || null, xlsxFileId: fileId } });
        await bot.api.sendMessage(
          chatId,
          `✅ Сравнение #${runId} готово${note ? ` ${note}` : ''} (ваш <code>${esc(our)}</code> + ${rivals.length} конкурентов). ` +
            `Данные сохранены: доступ у WB — 72 ч, у нас — навсегда.`,
          { parse_mode: 'HTML' }
        );
        if (fileId) {
          const f = getReportFile(db, fileId);
          await bot.api.sendDocument(chatId, new InputFile(Buffer.from(f.bytes), f.filename), {
            caption: `#${runId} · Сравнение карточек · XLSX`,
          });
        }
        return fileId;
      };

      try {
        const res = await runCardsComparison({ our, rivals, submit: true, out });
        await deliver(res);
      } catch (e) {
        // Прогон мог прерваться ПОСЛЕ клика «Сравнить» (спенд прошёл), но до выгрузки.
        // Пробуем бесплатно до-скачать готовое сравнение из истории (в пределах 72 ч).
        await bot.api
          .sendMessage(
            chatId,
            `⚠️ Прогон #${runId} прервался (${esc(String(e.message).slice(0, 120))}). Пробую восстановить готовое сравнение бесплатно…`
          )
          .catch(() => {});
        try {
          const rec = await runCardsComparison({ our, exportExisting: true, out });
          if (rec?.out && fs.existsSync(rec.out)) {
            await deliver(rec, '(восстановлено из истории — лимит не потрачен повторно)');
            return;
          }
        } catch (_) {
          /* нечего восстанавливать */
        }
        finishRun(db, runId, { error: e.message });
        await ccError(chatId, runId, e);
      }
    },
    { lane: 'wb.cards-compare' }
  );
}

// ─────────────── «Конкурентный анализ» (Python-движок → HTML/PDF) ───────────────

/** Краткая сводка ниши из JSON-агрегатов движка (защищённо). */
function caSummary(j) {
  const p = [];
  if (j?.niche)
    p.push(`📦 Ёмкость: <b>${fmt(j.niche.total_revenue)} ₽</b> · ${j.niche.players} продавцов · ${j.niche.skus} SKU`);
  if (j?.price_zone)
    p.push(`💰 Зона объёма: ${fmt(j.price_zone.lo)}–${fmt(j.price_zone.hi)} ₽ (медиана ${fmt(j.price_zone.wmedian)})`);
  const c = j?.economics?.corridor;
  if (c) {
    const lo = Array.isArray(c) ? c[0] : c.lo ?? c.min;
    const hi = Array.isArray(c) ? c[1] : c.hi ?? c.max;
    if (lo && hi) p.push(`✅ Коридор по марже 25–30%: <b>${fmt(lo)}–${fmt(hi)} ₽</b>`);
  }
  if (j?.top?.[0]) p.push(`🏆 Лидер: ${esc(j.top[0].name)} — ${fmt(j.top[0].revenue)} ₽`);
  return p.join('\n');
}

/** Запуск движка → сводка + HTML/PDF файлами. */
async function startCompetitorAnalysis({ manifest, chatId, telegramId, params }) {
  const { id: runId } = createRun(db, { telegramId, skill: manifest.id, params, status: 'running' });
  await bot.api.sendMessage(
    chatId,
    `⏳ Задача #${runId} «${esc(manifest.title)}» — собираю нишу из MPStats и считаю экономику (до пары минут)…`
  );
  const htmlOut = path.join(RUNS_DIR, `ca-${runId}.html`);
  const pdfOut = path.join(RUNS_DIR, `ca-${runId}.pdf`);
  const jsonOut = path.join(RUNS_DIR, `ca-${runId}.json`);
  const argv = manifest.buildArgv(params, { htmlOut, pdfOut, jsonOut });
  queue.enqueue(
    async () => {
      const res = await runCli({ npmScript: manifest.npmScript, argv, cwd: ROOT, timeoutMs: 300000 });
      if (!res.ok && !fs.existsSync(htmlOut)) {
        const msg = tail(res.stderr || res.stdout || `код ${res.code}`, 500);
        finishRun(db, runId, { error: msg });
        await bot.api
          .sendMessage(chatId, `❌ Анализ #${runId}: не удалось.\n<code>${esc(msg)}</code>`, { parse_mode: 'HTML' })
          .catch(() => {});
        return;
      }
      let summary = '';
      try {
        summary = caSummary(JSON.parse(fs.readFileSync(jsonOut, 'utf8')));
      } catch {
        /* без сводки */
      }
      finishRun(db, runId, { result: { params, jsonOut } });
      await bot.api.sendMessage(
        chatId,
        `✅ <b>Конкурентный анализ #${runId}</b>\n${summary}\n\n<i>Полный отчёт — в файлах ниже. В конце — чек-лист ручной доработки карточки.</i>`,
        { parse_mode: 'HTML' }
      );
      for (const [format, fpath, mime] of [
        ['pdf', pdfOut, 'application/pdf'],
        ['html', htmlOut, 'text/html'],
      ]) {
        if (!fs.existsSync(fpath)) continue;
        try {
          const bytes = fs.readFileSync(fpath);
          const fileId = saveReportFile(db, {
            source: `bot.${manifest.id}`,
            entity: String(runId),
            filename: `анализ-ниши-${runId}.${format}`,
            mime,
            bytes,
          });
          saveArtifact(db, runId, format, fileId);
          await bot.api.sendDocument(chatId, new InputFile(fpath, `анализ-ниши-${runId}.${format}`), {
            caption: `#${runId} · Конкурентный анализ · ${format.toUpperCase()}`,
          });
        } catch (e) {
          await bot.api.sendMessage(chatId, `⚠️ ${format.toUpperCase()} не отправлен: ${esc(e.message)}`).catch(() => {});
        }
      }
    },
    { lane: 'mpstats' } // общий лимит MPStats с «Конкуренты по запросу»
  );
}

// ─────────────── команды ───────────────

bot.command('start', async (ctx) => {
  ctx.session.flow = null;
  await ctx.reply(
    'Привет! Я собираю отчёты по Wildberries. Выберите отчёт в меню, ответьте на пару вопросов — и я подготовлю результат.'
  );
  await showMenu(ctx);
});

bot.command(['skills', 'menu'], showMenu);

bot.command('cancel', async (ctx) => {
  ctx.session.flow = null;
  await ctx.reply('Отменено. /skills — начать заново.');
});

// ─────────────── инлайн-кнопки ───────────────

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [action, key, ...rest] = data.split(':');
  const value = rest.join(':');

  // Выбор скилла из меню
  if (action === 'menu') {
    const manifest = manifestOf(key);
    if (!manifest) return ctx.answerCallbackQuery({ text: 'Скилл не найден', show_alert: true });
    ctx.session.flow = fsm.startFlow(manifest);
    await ctx.answerCallbackQuery();
    return showScreen(ctx, manifest, ctx.session.flow);
  }

  if (action === 'noop') return ctx.answerCallbackQuery();

  // ── действия над готовым прогоном (по runId, вне сессии) ──
  if (action === 'fmt') {
    await ctx.answerCallbackQuery({ text: `${value.toUpperCase()}…` });
    return deliverFormat({ runId: Number(key), chatId: ctx.chat.id, format: value });
  }
  if (action === 'pick' || action === 'pkt' || action === 'pkok') {
    const runId = Number(key);
    const run = getRun(db, runId);
    if (!run || !run.result) {
      await ctx.answerCallbackQuery({ text: 'Данные недоступны', show_alert: true });
      return;
    }
    const rivals = Array.isArray(run.result.rivals) ? run.result.rivals : [];
    const sel = selectedSet(run);
    const step = (registry.get(run.skill)?.steps || []).find((s) => s.interaction === 'pick-list') || {};
    const min = step.min ?? 2;
    const max = step.max ?? 4;

    if (action === 'pick') {
      await ctx.answerCallbackQuery();
      return sendPhotoPicker(ctx.chat.id, runId, rivals, sel, { min, max });
    }
    if (action === 'pkt') {
      const idx = Number(value);
      const nm = String(rivals[idx]?.nmId);
      if (nm && nm !== 'undefined') {
        if (sel.has(nm)) sel.delete(nm);
        else if (sel.size >= max) {
          await ctx.answerCallbackQuery({ text: `Не больше ${max}`, show_alert: true });
          return;
        } else sel.add(nm);
        saveSelected(runId, run, sel);
      }
      await ctx.answerCallbackQuery({ text: `Выбрано: ${sel.size}` });
      // редактируем тумблер ИМЕННО под этим фото
      return ctx
        .editMessageReplyMarkup({ reply_markup: kb.photoToggleKeyboard(runId, idx, sel.has(nm)) })
        .catch(() => {});
    }
    if (action === 'pkok') {
      if (sel.size < min) {
        await ctx.answerCallbackQuery({ text: `Нужно минимум ${min}`, show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Сохранено' });
      const chosen = rivals.filter((r) => sel.has(String(r.nmId)));
      const list = chosen.map((r) => `• <code>${esc(r.nmId)}</code> · ${esc(r.brand || '—')}`).join('\n');
      return ctx.reply(
        `✅ Выбрано ${chosen.size} конкурентов (задача #${runId}):\n${list}\n\n` +
          `Сравнить их с вашей карточкой (воронка из кабинета)?`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('📊 Сравнить с моим артикулом', `cc2:${runId}`),
        }
      );
    }
  }

  // каскад [1]→[2]: запустить «Сравнение карточек» с конкурентами из пикера
  if (action === 'cc2') {
    const runId = Number(key);
    const run = getRun(db, runId);
    const rivals = (run?.result?._selected || []).map(String);
    if (rivals.length < 2) {
      await ctx.answerCallbackQuery({ text: 'Сначала выберите 2–4 конкурента', show_alert: true });
      return;
    }
    const ccManifest = registry.get('wb-cards-compare');
    const flow = fsm.startFlow(ccManifest);
    flow.params.rivals = rivals.join(','); // конкуренты уже есть — спросим только «наш»
    ctx.session.flow = flow;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Конкуренты взяты из отчёта #${runId} (${rivals.length} шт.). Теперь укажите <b>ваш</b> артикул для сравнения:`,
      { parse_mode: 'HTML' }
    );
    return showScreen(ctx, ccManifest, flow);
  }

  // подтверждение/отмена «Сравнения карточек» (по runId)
  if (action === 'ccok' || action === 'cccancel') {
    const runId = Number(key);
    const run = getRun(db, runId);
    if (!run) {
      await ctx.answerCallbackQuery({ text: 'Задача не найдена', show_alert: true });
      return;
    }
    if (action === 'cccancel') {
      finishRun(db, runId, { error: 'отменено пользователем' });
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      await ctx.editMessageReplyMarkup({}).catch(() => {});
      return ctx.reply(`Сравнение #${runId} отменено. Лимит не потрачен.`);
    }
    await ctx.answerCallbackQuery({ text: 'Запускаю сравнение' });
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    return runCcSubmit({ runId, chatId: ctx.chat.id });
  }

  const flow = ctx.session.flow;
  if (!flow) {
    await ctx.answerCallbackQuery();
    return ctx.reply('Диалог не активен. /skills — выбрать отчёт.');
  }
  const manifest = manifestOf(flow.skill);

  if (action === 'set') {
    const field = manifest.fields.find((f) => f.key === key);
    if (!field) return ctx.answerCallbackQuery();
    let v = value;
    if (field.type === 'boolean') v = value === '1';
    else if (field.type === 'choice') {
      const opt = (field.options || []).find((o) => String(o.value) === String(value));
      v = opt ? opt.value : value;
    }
    fsm.applyValue(manifest, flow, key, v);
    await ctx.answerCallbackQuery();
    return showScreen(ctx, manifest, flow);
  }

  if (action === 'advf') {
    const field = manifest.fields.find((f) => f.key === key);
    if (!field) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    if (field.type === 'choice') return ctx.reply(`${field.label}?`, { reply_markup: kb.choiceKeyboard(field) });
    if (field.type === 'boolean') return ctx.reply(`${field.label}?`, { reply_markup: kb.booleanKeyboard(field) });
    fsm.setAsking(manifest, flow, key);
    const extra = [field.hint, field.placeholder].filter(Boolean).join(' · ');
    return ctx.reply(`Введите: <b>${esc(field.label)}</b>${extra ? `\n<i>${esc(extra)}</i>` : ''}`, {
      parse_mode: 'HTML',
    });
  }

  if (action === 'adv') {
    if (key === 'cfg') fsm.configureAdvanced(flow);
    else fsm.toConfirm(flow); // skip | done
    await ctx.answerCallbackQuery();
    return showScreen(ctx, manifest, flow);
  }

  if (action === 'cfm') {
    if (key === 'cancel') {
      ctx.session.flow = null;
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      return ctx.reply('Отменено. /skills — начать заново.');
    }
    if (key === 'edit') {
      fsm.restartCollect(manifest, flow);
      await ctx.answerCallbackQuery();
      return showScreen(ctx, manifest, flow);
    }
    // run — выполнение
    const params = { ...flow.params };
    const chatId = ctx.chat.id;
    const telegramId = ctx.from?.id ?? null;
    ctx.session.flow = null;
    await ctx.answerCallbackQuery({ text: 'Запускаю' });

    // Кастомный исполнитель (браузерная автоматизация с DRY-RUN/подтверждением)
    if (manifest.runner === 'cardsCompare') {
      return startCardsCompare({ manifest, chatId, telegramId, params });
    }
    // Конкурентный анализ (Python-движок → HTML/PDF/JSON-файлы)
    if (manifest.runner === 'competitorAnalysis') {
      return startCompetitorAnalysis({ manifest, chatId, telegramId, params });
    }

    // Обычный CLI-исполнитель через очередь
    const { id: runId } = createRun(db, { telegramId, skill: manifest.id, params, status: 'queued' });
    await ctx.reply(
      `⏳ Задача <b>#${runId}</b> «${esc(manifest.title)}» поставлена в очередь. Это может занять до пары минут — пришлю результат сюда.`,
      { parse_mode: 'HTML' }
    );
    enqueueRun({ manifest, runId, chatId, params });
    return;
  }

  return ctx.answerCallbackQuery();
});

// ─────────────── текстовый ввод (ответ на «Введите …») ───────────────

bot.on('message:text', async (ctx) => {
  const flow = ctx.session.flow;
  if (!flow || !flow.asking) {
    return ctx.reply('Чтобы собрать отчёт — /skills.');
  }
  const manifest = manifestOf(flow.skill);
  const field = manifest.fields.find((f) => f.key === flow.asking.key);
  const res = fsm.coerceInput(field, ctx.message.text);
  if (!res.ok) return ctx.reply(`⚠️ ${res.error} Повторите ввод.`);
  fsm.applyValue(manifest, flow, field.key, res.value);
  return showScreen(ctx, manifest, flow);
});

// ─────────────── ошибки ───────────────

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('Ошибка Telegram API:', e.description);
  else if (e instanceof HttpError) console.error('Сеть Telegram:', e);
  else console.error('Ошибка обработчика:', e);
});

function shellQuote(s) {
  return /[^\w@%+=:,./-]/.test(String(s)) ? `'${String(s).replace(/'/g, `'\\''`)}'` : String(s);
}

console.log(`Реестр: ${[...registry.keys()].join(', ') || '(пусто)'}`);
bot.start({
  onStart: (me) => console.log(`Бот @${me.username} (id ${me.id}) запущен.`),
});
