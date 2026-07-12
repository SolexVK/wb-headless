// Тесты чистых функций бота. Запуск: npm test  (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { toHtml, escapeHtml, chunk, summarizeTool, loadDotenv, parseProjects } from '../telegram-bot.js';

test('escapeHtml экранирует спецсимволы', () => {
  assert.equal(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('toHtml: жирный и инлайн-код', () => {
  assert.equal(toHtml('**bold** and `code`'), '<b>bold</b> and <code>code</code>');
});

test('toHtml: код-блок с языком превращается в pre/code без строки языка', () => {
  const out = toHtml('текст\n```js\nconst x = 1 < 2;\n```\nещё');
  assert.match(out, /<pre><code>const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.ok(!out.includes('```'));
});

test('toHtml: экранирует HTML вне кода', () => {
  assert.equal(toHtml('1 < 2 && 3 > 2'), '1 &lt; 2 &amp;&amp; 3 &gt; 2');
});

test('chunk: короткий текст — один кусок', () => {
  const parts = chunk('привет');
  assert.equal(parts.length, 1);
  assert.equal(parts[0], 'привет');
});

test('chunk: длинный текст режется по лимиту Telegram (4096)', () => {
  const long = 'x'.repeat(10000);
  const parts = chunk(long);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 4096);
  assert.equal(parts.join('').length, 10000);
});

test('chunk: пустой текст даёт заглушку', () => {
  assert.deepEqual(chunk(''), ['(пустой ответ)']);
});

test('summarizeTool: имя инструмента и подсказка из input', () => {
  assert.equal(summarizeTool({ name: 'Edit', input: { file_path: 'server.js' } }), '🔧 Edit: server.js');
  assert.equal(summarizeTool({ name: 'Bash', input: { command: 'npm test' } }), '🔧 Bash: npm test');
  assert.equal(summarizeTool({ name: 'Read', input: {} }), '🔧 Read');
});

test('summarizeTool: длинная подсказка обрезается', () => {
  const line = summarizeTool({ name: 'Bash', input: { command: 'a'.repeat(300) } });
  assert.ok(line.length <= 3 + 5 + 2 + 120); // эмодзи+имя+': '+120
  assert.ok(line.endsWith('…'));
});

test('parseProjects: пусто → один проект default', () => {
  delete process.env.BOT_PROJECTS;
  const p = parseProjects();
  assert.deepEqual(Object.keys(p), ['default']);
});

test('parseProjects: парсит "name:/path" через запятую', () => {
  process.env.BOT_PROJECTS = 'wb:/srv/wb, other:/srv/other';
  const p = parseProjects();
  assert.equal(p.wb, '/srv/wb');
  assert.equal(p.other, '/srv/other');
  delete process.env.BOT_PROJECTS;
});

test('loadDotenv: парсит переменные, игнорирует комментарии, не перетирает окружение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    '# комментарий',
    'FOO=bar',
    'QUOTED="hello world"',
    "SINGLE='x y'",
    'EXISTING=fromfile',
    '',
  ].join('\n'));
  process.env.EXISTING = 'fromenv';
  loadDotenv(file);
  assert.equal(process.env.FOO, 'bar');
  assert.equal(process.env.QUOTED, 'hello world');
  assert.equal(process.env.SINGLE, 'x y');
  assert.equal(process.env.EXISTING, 'fromenv'); // реальное окружение приоритетнее
  delete process.env.FOO; delete process.env.QUOTED; delete process.env.SINGLE; delete process.env.EXISTING;
  fs.rmSync(dir, { recursive: true, force: true });
});
