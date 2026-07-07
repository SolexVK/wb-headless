// bot/core/executor.js — запуск CLI-скилла как дочернего процесса.
//
// Гонит `npm run <script> -- <argv>` в корне репозитория, наследует env (токены
// MPSTATS_TOKEN / Wildberries_API берутся из окружения бота), по завершении читает
// JSON-контракт из outJson. Возвращает результат без исключений (ошибки — в поле).

import { spawn } from 'child_process';
import fs from 'fs';

/**
 * @param {object} o
 * @param {string} o.npmScript   имя npm-скрипта (напр. 'top:keywords')
 * @param {string[]} o.argv      аргументы после `--`
 * @param {string} o.cwd         корень репозитория
 * @param {string} [o.outJson]   путь к JSON-контракту (если скилл пишет --out)
 * @param {number} [o.timeoutMs] таймаут (по умолчанию 5 мин)
 * @returns {Promise<{ok, code, stdout, stderr, data}>}
 */
export function runCli({ npmScript, argv, cwd, outJson, timeoutMs = 300000 }) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', npmScript, '--', ...argv], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${e.message}`, data: null });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let data = null;
      if (outJson && fs.existsSync(outJson)) {
        try {
          data = JSON.parse(fs.readFileSync(outJson, 'utf8'));
        } catch (e) {
          stderr += `\nне удалось разобрать JSON: ${e.message}`;
        }
      }
      const ok = !timedOut && code === 0 && (!outJson || data != null);
      resolve({ ok, code: timedOut ? 'timeout' : code, stdout, stderr, data });
    });
  });
}

/** Хвост текста (для сообщения об ошибке в чат). */
export function tail(s, n = 600) {
  const t = String(s || '').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}
