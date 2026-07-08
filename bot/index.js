// bot/index.js — точка входа Telegram-бота (grammY).
//
// Меню из реестра → сбор формы → подтверждение → выполнение (очередь+CLI) →
// готовый прогон: выбор формата (HTML/PDF/XLSX) и пикер конкурентов (2–4).

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Bot, InputFile, session, GrammyError, HttpError } from 'grammy';
import {
  openDb, createRun, updateRun, finishRun, getRun,
  saveReportFile, getReportFile, saveArtifact, getArtifact,
} from '../lib/db.js';
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
          `<i>Пойдут в «Сравнение карточек», когда подключим этот скилл. nmId сохранены в прогоне.</i>`,
        { parse_mode: 'HTML' }
      );
    }
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
    // run — этап 3b: реальное выполнение через очередь
    const params = { ...flow.params };
    const chatId = ctx.chat.id;
    ctx.session.flow = null;
    const { id: runId } = createRun(db, {
      telegramId: ctx.from?.id ?? null,
      skill: manifest.id,
      params,
      status: 'queued',
    });
    await ctx.answerCallbackQuery({ text: 'Запускаю' });
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
