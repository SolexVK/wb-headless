// bot/render/index.js — единая точка рендера отчёта в формат.
//
// renderReport({ skill, format, data, outDir, runId }) → { path, filename, mime }.
// Диспетчеризует по скиллу; каждый скилл имеет модуль bot/render/<skill>.js с
// функциями html/pdf/xlsx. Добавить формат/скилл — добавить модуль здесь.

import fs from 'fs';
import path from 'path';

const RENDERERS = {
  'wb-top-keywords': () => import('./wb-top-keywords.js'),
};

const MIME = {
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const slug = (s) =>
  String(s || 'report')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'report';

export function isSupported(skill, format) {
  return !!RENDERERS[skill] && ['html', 'pdf', 'xlsx'].includes(format);
}

/**
 * Рендерит отчёт в файл.
 * @returns {Promise<{path, filename, mime}>}
 */
export async function renderReport({ skill, format, data, outDir, runId, images = true, baseName }) {
  const load = RENDERERS[skill];
  if (!load) throw new Error(`нет рендерера для скилла ${skill}`);
  if (!MIME[format]) throw new Error(`формат ${format} не поддержан`);
  const r = await load();

  const stem = baseName || `${slug(data?.query)}-${runId}`;
  const filename = `${stem}.${format}`;
  const outPath = path.join(outDir, filename);

  if (format === 'html') {
    fs.writeFileSync(outPath, await r.html(data, { images }));
  } else if (format === 'pdf') {
    await r.pdf(data, outPath, { images });
  } else if (format === 'xlsx') {
    r.xlsx(data, outPath);
  }
  return { path: outPath, filename, mime: MIME[format] };
}
