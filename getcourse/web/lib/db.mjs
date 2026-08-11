// Tiny JSON-file datastore (no external DB). Holds users, sessions and a
// persisted record of jobs. Writes are atomic (write temp + rename).
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.GCUI_DATA || path.join(process.cwd(), 'web', 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');

const empty = { users: [], sessions: [], jobs: [] };
let state = null;

function ensure() {
  if (state) return state;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try { state = { ...empty, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
    catch { state = { ...empty }; }
  } else {
    state = { ...empty };
  }
  return state;
}

export function save() {
  ensure();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const db = {
  get dataDir() { return DATA_DIR; },
  get users() { return ensure().users; },
  get sessions() { return ensure().sessions; },
  get jobs() { return ensure().jobs; },
  save,
};
