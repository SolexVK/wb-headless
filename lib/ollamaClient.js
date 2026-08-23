// lib/ollamaClient.js — вызовы локальной Ollama с контролем памяти.
//
// Машина общая и памяти 16 ГБ, а 12B-модель занимает около 9 ГБ. Поэтому:
//   • модель выгружается из памяти явно (keep_alive: 0) после каждого кластера;
//   • перед кластером проверяется своп — если он растёт, ждём или прерываемся;
//   • контекст держим минимальный: одна картинка + короткий промпт.
//
// Ничего не устанавливает и чужие процессы не трогает.

import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/** Один запрос к модели. Схема — JSON Schema, попадает в поле format. */
export async function ask(model, prompt, imagesB64, {
  schema = null, numPredict = 200, numCtx = 2048, keepAlive = '5m', timeoutMs = 180000,
} = {}) {
  const body = {
    model,
    prompt,
    images: imagesB64,
    stream: false,
    keep_alive: keepAlive,
    format: schema || 'json',
    options: { temperature: 0, num_predict: numPredict, num_ctx: numCtx },
  };
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ms = Date.now() - t0;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Ollama ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  const raw = (j.response || '').trim();
  try {
    return { data: JSON.parse(raw), ms, raw };
  } catch (_) {
    return { data: null, ms, raw };
  }
}

/** Выгружает модель из памяти немедленно. Идемпотентно, ошибки глотает. */
export async function unload(model) {
  try {
    await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (_) { /* не критично */ }
}

/** Что сейчас загружено в память Ollama. */
export async function loaded() {
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    return (j.models || []).map((m) => ({
      name: m.name, sizeGb: (m.size || 0) / 1024 ** 3, until: m.expires_at,
    }));
  } catch (_) {
    return [];
  }
}

/**
 * Состояние памяти macOS: свободно, своп, доля сжатой памяти.
 * @returns {Promise<{freeGb:number, swapUsedMb:number, pageoutsPerSec:?number}>}
 */
export async function memory() {
  const out = { freeGb: NaN, swapUsedMb: NaN };
  try {
    const { stdout } = await exec('/usr/bin/vm_stat');
    const page = Number(/page size of (\d+)/.exec(stdout)?.[1]) || 16384;
    const num = (re) => Number((re.exec(stdout)?.[1] || '0').replace(/\./g, ''));
    const free = num(/Pages free:\s+(\d+)/);
    const inactive = num(/Pages inactive:\s+(\d+)/);
    const spec = num(/Pages speculative:\s+(\d+)/);
    out.freeGb = ((free + inactive + spec) * page) / 1024 ** 3;
  } catch (_) { /* не macOS */ }
  try {
    const { stdout } = await exec('/usr/sbin/sysctl', ['-n', 'vm.swapusage']);
    const m = /used\s*=\s*([\d.,]+)([MG])/.exec(stdout);
    if (m) {
      const v = Number(m[1].replace(',', '.'));
      out.swapUsedMb = m[2] === 'G' ? v * 1024 : v;
    }
  } catch (_) { /* не macOS */ }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ждёт, пока память придёт в норму после выгрузки модели.
 * Возвращает false, если за maxWaitMs своп так и не опустился ниже порога —
 * значит на машине что-то ещё съедает память и продолжать опасно.
 */
export async function waitForMemory({
  minFreeGb = 3, maxSwapMb = 3072, maxWaitMs = 120000, stepMs = 5000, log = () => {},
} = {}) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const m = await memory();
    const okFree = !Number.isFinite(m.freeGb) || m.freeGb >= minFreeGb;
    const okSwap = !Number.isFinite(m.swapUsedMb) || m.swapUsedMb <= maxSwapMb;
    if (okFree && okSwap) return true;
    if (Date.now() > deadline) {
      log(`память не восстановилась: свободно ${m.freeGb.toFixed(1)} ГБ, `
        + `своп ${Math.round(m.swapUsedMb)} МБ`);
      return false;
    }
    log(`жду память: свободно ${m.freeGb.toFixed(1)} ГБ, своп ${Math.round(m.swapUsedMb)} МБ`);
    await sleep(stepMs);
  }
}

export { sleep };
