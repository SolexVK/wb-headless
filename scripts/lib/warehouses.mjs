// scripts/lib/warehouses.mjs — единый резолвер списка НАШИХ складов-фулфилментов.
//
// Проблема, которую решает: раньше отчёты брали id→имя и «московские ФФ» из
// СТАТИЧНОГО config/warehouses.json (снимок складов одного продавца). Из-за
// этого новые фулфилменты попадали в отчёты без имени («склад 12345»), а новые
// МОСКОВСКИЕ ФФ вовсе выпадали из московского разреза «Географии»; в мультитенанте
// имена/классификация были от чужого кабинета.
//
// Теперь склады берём ЖИВЫМ запросом WB (GET /api/v3/warehouses) по токену
// текущего кабинета. Это авторитетный, всегда актуальный список продавца — новые
// ФФ подхватываются автоматически. При офлайне/ошибке — откат на config-снимок,
// чтобы пайплайн не падал (в тестах/без сети).
//
// Использование в пайплайне:
//   import { loadWarehouses } from './lib/warehouses.mjs';
//   const WH = await loadWarehouses(wb);            // wb — экземпляр WbClient
//   WH.nameOf(o.warehouseId)                        // имя ФФ (или «склад <id>»)
//   WH.moscowIds.has(o.warehouseId)                 // московский ли ФФ
//   WH.moscowNames                                  // список имён московских ФФ
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const MOSCOW_RE = /мск|москв/i; // московская зона по имени склада

function build(list, source) {
  const nameById = new Map();
  const moscowIds = new Set();
  const moscowNames = [];
  for (const w of list) {
    if (w == null || w.id == null) continue;
    const name = String(w.name ?? '').trim();
    nameById.set(w.id, name);
    if (MOSCOW_RE.test(name)) { moscowIds.add(w.id); moscowNames.push(name); }
  }
  return {
    source,                                   // 'api' | 'config' | 'empty'
    all: list,
    nameById,
    moscowIds,
    moscowNames,
    nameOf: (id) => nameById.get(id) || ('склад ' + id),
    isMoscow: (id) => moscowIds.has(id),
  };
}

function fromConfig() {
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'warehouses.json'), 'utf8'));
    return build(snap.warehouses || [], 'config');
  } catch {
    return build([], 'empty');
  }
}

// Живой список складов кабинета. methodLimit — необязательный лимит метода.
//
// МУЛЬТИТЕНАНТ: при ошибке WB НЕ подставляем config/warehouses.json — это снимок складов
// ОДНОГО продавца, и в мультитенанте он подсунул бы кабинету B имена/классификацию Москвы
// кабинета A (утечка данных между тенантами). По умолчанию откатываемся на ПУСТОЙ список:
// неизвестные id рендерятся как «склад <id>» — некрасиво, но безопасно и не чужое.
// Config-снимок как именослов доступен только по явному opt-in (одно-продавцовые CLI-прогоны).
export async function loadWarehouses(wb, { methodLimit } = {}) {
  try {
    const { data } = await wb.get('marketplace', '/api/v3/warehouses', methodLimit ? { methodLimit } : undefined);
    if (Array.isArray(data)) return build(data, 'api'); // пустой список у кабинета — тоже валидно
  } catch { /* нет сети/прав — безопасный откат ниже */ }
  if (process.env.WB_WAREHOUSES_FALLBACK_CONFIG === '1') return fromConfig();
  return build([], 'empty');
}
