# bot/ — Telegram-бот WB-скиллов

Всё бот-специфичное живёт здесь, отдельно от продакшн-кода скиллов
(`.claude/skills/`, `lib/`, `scripts/`). Архитектура — `docs/telegram-bot/ARCHITECTURE.md`.

```
bot/
  index.js            # точка входа grammY (позже)
  core/
    registry.js       # загрузка/валидация манифестов, помощники формы  ✅
    fsm.js            # машина состояний диалога (позже)
    queue.js          # очередь задач + воркеры + семафоры лимитов (позже)
    executor.js       # cli / claude адаптеры (позже)
    cache.js          # обёртка над source_cache (Слой 1) (позже)
  render/             # шаблоны форматов HTML/PDF/XLSX (позже)
  skills/
    <skill>.manifest.js   # бот-обёртка скилла: форма, шаги, форматы, кэш
```

## Как добавить скилл

Положить `bot/skills/<id>.manifest.js` с `export default { … }`. Ядро бота не меняется.

### Схема манифеста

| Поле | Обяз. | Описание |
|---|---|---|
| `id` | ✅ | Уникальный id (совпадает с именем скилла) |
| `title` | ✅ | Человекочитаемое имя для меню (с эмодзи) |
| `description` | | Короткое описание под именем |
| `adminOnly` | | `true` — скрыт из меню обычных пользователей |
| `engineeringMode` | | `true` — доступен инженерный режим (правка скилла, только админам) |
| `npmScript` | | Имя npm-скрипта CLI-исполнителя (`npm run <script> -- <argv>`) |
| `fields[]` | ✅ | Схема формы (см. ниже) |
| `steps[]` | | Шаги выполнения: `executor` (`cli`/`claude`), `buildArgv(params, ctx)`, `interaction` (`pick-list`/`confirm-dry-run`/`creds-refresh`) |
| `formats[]` | | Поддерживаемые форматы вывода: `html`/`pdf`/`xlsx` |
| `cache` | | `{ source, key(params) }` — ключ дорогой вытяжки для Слоя 1 |

### Поле формы (`fields[]`)

| Ключ | Описание |
|---|---|
| `key` | Имя параметра (уникально) |
| `label` | Подпись для пользователя |
| `type` | `text` \| `number` \| `choice` \| `multichoice` \| `boolean` \| `date-range` |
| `required` | Обязательное — спрашивается сразу |
| `advanced` | Прячется под «⚙ Настроить» |
| `default` | Значение по умолчанию (`withDefaults`) |
| `options[]` | Для `choice`/`multichoice`: `{ value, label }` |
| `showIf(params)` | Показывать поле только при условии (напр. `d1` при `period==='custom'`) |
| `hint` / `placeholder` | Подсказки |

Помощники FSM из `core/registry.js`: `menuItems`, `formPlan`, `visibleFields`,
`missingRequired`, `withDefaults`.

Образец — `bot/skills/wb-top-keywords.manifest.js`.
