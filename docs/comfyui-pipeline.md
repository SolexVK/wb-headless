# ComfyUI-пайплайн + обучение LoRA — техническая спецификация

> Часть 1 углублённого плана «Live Model». Здесь — конкретный технический конвейер:
> от подготовки датасета и обучения LoRA-личности до генерации фотореалистичных кадров
> с настоящей кожей. Все параметры даны с реальными значениями и пометками о вариациях.
>
> Важно: экосистема быстро меняется. Ниже базой взят **Flux.1 Dev** (проверенный стандарт
> ниши на 2025). Есть отличия у нового **Flux 2** — они помечены отдельно.

---

## 0. Железо и окружение

| Компонент | Рекомендация |
|---|---|
| GPU для генерации | 12 GB VRAM минимум (fp8), комфортно — 16–24 GB (RTX 4090 / A5000) |
| GPU для обучения LoRA | FluxGym работает от 12 GB; комфортно 20–24 GB. Облако — **RunPod** (RTX 4090 / A100) |
| Диск | 50–100 GB (модели Flux ~23 GB fp16 / ~11 GB fp8 + T5 + VAE) |
| Софт | **ComfyUI** (генерация) + **FluxGym** или **Kohya SS** (обучение) |

**Почему облако (RunPod):** аренда мощного GPU по часам дешевле покупки и проще для старта.
Берёшь готовый шаблон (ComfyUI / FluxGym template), обучение LoRA ~2 часа на A100/4090.

### Базовые модели (скачать в ComfyUI)
```
models/unet/         flux1-dev-fp8.safetensors        (или fp16, если хватает VRAM)
models/clip/         t5xxl_fp8_e4m3fn.safetensors
models/clip/         clip_l.safetensors
models/vae/          ae.safetensors                    (Flux VAE)
models/loras/        <твоя-LoRA>.safetensors           (появится после обучения)
```

---

## 1. Датасет для LoRA-личности

Это фундамент. Плохой датасет = «плавающее» лицо, которое разрушает иллюзию живого человека.

- **Количество:** 20–30 изображений (реже 15). Качество важнее количества.
- **Разрешение:** 1024×1024 (ресайз всего датасета к 1024).
- **Разнообразие (критично для консистентности):**
  - ракурсы: анфас, 3/4, профиль, сверху/снизу;
  - планы: крупный портрет, по пояс, в полный рост;
  - освещение: дневное, студийное, закат, помещение;
  - выражения лица и позы — разные;
  - фон — по возможности чистый/нейтральный, чтобы модель училась лицу, а не фону.
- **Откуда взять первый набор:** сгенерировать «нулевую» версию персоны в ComfyUI/Midjourney
  (зафиксировать seed + промпт-шаблон), отобрать 20–30 лучших кадров, где лицо максимально
  одинаковое → на них обучить LoRA, которая «зацементирует» образ.

### Подписи (captions)
- Автоподпись через **Florence-2** (встроено в FluxGym) → затем ручная вычитка.
- В каждую подпись добавляется **триггер-слово** (уникальное, напр. `aitn_woman`), которым потом
  вызываешь персону в промпте.
- Описывай **то, что должно меняться** (одежда, поза, фон, свет) и НЕ описывай постоянные черты
  лица — так модель «привязывает» лицо к триггеру, а не к словам.

---

## 2. Обучение LoRA (FluxGym / Kohya)

**FluxGym** — самый простой UI для Flux LoRA с поддержкой low-VRAM. Пайплайн: загрузить фото →
задать триггер → авто-caption (Florence-2) → выставить параметры → Start.

### Рекомендуемые параметры (Flux.1 Dev, портрет/персонаж)

| Параметр | Значение | Комментарий |
|---|---|---|
| Resolution | 1024 | ресайз датасета |
| Network dim (rank) | **32–48** | 32 — проще лицо, 48 — сложные черты/детали |
| Network alpha | **rank / 2** | rank 32 → alpha 16; rank 48 → alpha 24 |
| Learning rate | **8e-4 … 1.2e-3** | старт 1e-3; сложный субъект → 8e-4 |
| Repeats / image | **10** | повторов на изображение за эпоху |
| Epochs | **12–15** | ~15–25 фото: 12 эпох обычно достаточно |
| Итоговые шаги | **~800–1500** | dim×repeats×epochs; следи, чтобы не переобучить |
| Optimizer | AdamW8bit / Prodigy | 8bit — экономия VRAM |
| Save every N epochs | 1–2 | чтобы выбрать лучший чекпоинт |
| VRAM mode | 12 / 16 / 20 GB | по своей карте |

> **Flux 2** (новее): learning rate выше — **1.0e-3 … 1.5e-3**, шаги **800–1500**, rank 32–48.
> SDXL для сравнения требует 3000–5000 шагов — Flux учится заметно быстрее.

### Как не переобучить (overfitting)
- Признаки перебора: одинаковая поза/фон везде, «выжженные» артефакты, модель не слушает промпт.
- Лечится: меньше эпох/шагов, alpha = rank/4 вместо rank/2, больше разнообразия в датасете.
- **Сохраняй чекпоинты по эпохам** и сравнивай — часто лучший результат на эпохе 8–12, а не 15.
- Время обучения: **~1.5–2.5 часа** (зависит от GPU и размера датасета).

**Выход:** файл `<имя>.safetensors` → кладёшь в `ComfyUI/models/loras/`.

---

## 3. Генерация: базовый ComfyUI-workflow (txt2img на Flux)

Граф узлов (по порядку):

```
Load Diffusion Model (flux1-dev-fp8, weight_dtype=fp8_e4m3fn)
DualCLIPLoader (t5xxl_fp8 + clip_l, type=flux)
Load VAE (ae.safetensors)
        │
LoraLoaderModelOnly  ── твоя LoRA, strength 0.7–1.0
        │
CLIP Text Encode (+)  ── промпт с триггер-словом
FluxGuidance          ── guidance 3.0–3.5   ← это «CFG» для Flux, НЕ в KSampler
        │
EmptyLatentImage (1024×1024, или 832×1216 портрет)
        │
KSampler:
    sampler   = euler
    scheduler = simple   (или beta / sgm_uniform)
    steps     = 20–28
    cfg       = 1.0       ← важно! в самом KSampler cfg=1.0 для Flux Dev
    denoise   = 1.0
        │
VAE Decode → Save Image
```

### Критичные нюансы (частые ошибки)
- **cfg в KSampler = 1.0.** Flux Dev не использует classifier-free guidance как SDXL. Ставят
  3.5/7.0 по привычке от SDXL → получают выцветшую пересвеченную картинку. Сила «guidance»
  задаётся отдельным узлом **FluxGuidance (~3.5)**.
- **Сэмплер:** euler + simple — надёжный дефолт. Можно deis/beta для вариаций.
- **Шаги:** 20 — базово, 28 — чуть детальнее. Больше 30 обычно смысла нет.
- **fp8** снижает VRAM до ~16–17 GB с почти незаметной потерей качества.
- **Портрет:** латент 832×1216 / 896×1152 даёт лучшие лица, чем квадрат.

---

## 4. Реализм кожи — победа над «пластиком»

Главный признак «дешёвого AI» — восковая гладкая кожа. Решается стеком техник:

1. **Detail Daemon (sampler node)** — усиливает микродетали (поры, текстуру), не ломая
   композицию. Ключевой инструмент против гладкой кожи.
2. **Noise Injection (split sigmas)** — разрезаешь сигмы в середине сэмплинга и впрыскиваешь
   немного шума: высокий guidance на первых шагах, низкий на финальных → живее и «менее AI».
3. **Skin Detailer LoRA** — отдельная LoRA на текстуру кожи (грузится вместе с LoRA-личности,
   малой силой, чтобы не спорить с образом).
4. **FaceDetailer (ComfyUI Impact Pack)** — детекция лица через **Ultralytics** (bbox) + **SAM**
   (маска) → инпейнт только лица с малым denoise:
   - `denoise = 0.15–0.30` (обычно **~0.2**);
   - отдельно можно доработать глаза/губы своими масками.
5. **Апскейл с деталями** — тайловый апскейлер (напр. UltimateSDUpscale) 1.5–2×; VRAM-ёмкий,
   нужно 12 GB+. Повторное лёгкое noise injection на апскейле добавляет реализма.

### Мини-порядок «anti-plastic»
```
base gen (Flux + LoRA) → Detail Daemon + noise injection
                        → FaceDetailer (Ultralytics+SAM, denoise ~0.2)
                        → tile upscale 1.5–2× (+ лёгкий noise)
```

---

## 5. Консистентность лица «сверх LoRA» (когда нужно ещё стабильнее)

LoRA даёт основу, но для сложных сцен/видео-кадров добавляют:
- **PuLID / InstantID** (Flux) — перенос личности с 1–3 фото-референсов поверх генерации.
- **IPAdapter / FaceID** — быстрый перенос лица без обучения (для черновиков и вариаций).
- **Reactor / face swap** — как финальная страховка на «сложных» кадрах (осторожно с этикой/правами).

Практика: **LoRA (личность) + PuLID (подстраховка лица) + FaceDetailer (детализация)** —
рабочая связка для стабильного узнаваемого персонажа.

---

## 6. Чек-лист «фабрики фото»

1. [ ] Собрать 20–30 эталонных фото персоны (1024², разнообразие ракурсов/света).
2. [ ] Обучить LoRA в FluxGym на RunPod (rank 32–48, alpha=rank/2, LR ~1e-3, 12–15 эпох, repeats 10).
3. [ ] Выбрать лучший чекпоинт по эпохам (не всегда последний).
4. [ ] Настроить базовый Flux-workflow (euler/simple, 20–28 шагов, cfg=1.0, FluxGuidance 3.5).
5. [ ] Добавить anti-plastic стек (Detail Daemon + noise injection + FaceDetailer denoise ~0.2).
6. [ ] Добавить tile upscale 1.5–2×.
7. [ ] Зафиксировать промпт-шаблоны под сцены (кафе/спортзал/город/студия) и пакетно генерить.
8. [ ] Отбор + лёгкий ретушь → в контент-банк.

Дальше этот фото-банк идёт в видео-пайплайн (Kling/Runway/HeyGen) — разберём во второй части.

---

## Источники (техническая часть)

- [Apatero — Flux LoRA Training in ComfyUI (2025)](https://www.apatero.com/blog/flux-lora-training-comfyui-complete-guide-2025)
- [Apatero — How to Train Flux 2 LoRA (2025)](https://apatero.com/blog/how-to-train-flux-2-lora-complete-fine-tuning-guide-2025)
- [sanj.dev — How to Train a LoRA in 2026 (Kohya, FLUX, VRAM)](https://sanj.dev/post/lora-training-2025-ultimate-guide/)
- [Next Diffusion — Train a Flux LoRA with FluxGym on RunPod](https://www.nextdiffusion.ai/tutorials/how-to-train-a-flux-lora-with-fluxgym-on-runpod)
- [GitHub — cocktailpeanut/fluxgym (low VRAM Flux LoRA UI)](https://github.com/cocktailpeanut/fluxgym)
- [ThinkDiffusion — LoRA training with FluxGym](https://learn.thinkdiffusion.com/make-your-character-style-lora-stand-out-easy-lora-training-with-fluxgym/)
- [Civitai — Detailed Flux Training Guide: Dataset Preparation](https://civitai.com/articles/7777/detailed-flux-training-guide-dataset-preparation)
- [Thunder Compute — Flux ComfyUI Complete Guide (2026)](https://www.thundercompute.com/blog/flux-comfyui-ai-image-generation)
- [ComfyUI Wiki — FluxGuidance node](https://comfyui-wiki.com/en/comfyui-nodes/advanced/conditioning/flux/flux-guidance)
- [Civitai — Flux with Skin_Detailer (Detail Daemon + Noise Injection)](https://civitai.com/models/617451/flux-with-skindetailer-comfyui)
- [Civitai — Flux Skin Solved](https://civitai.com/articles/9430/flux-skin-solved)
- [Stable Diffusion Art — Skin Detailer for AI influencers](https://stable-diffusion-art.com/skin-detailer/)
- [RunPod — ComfyUI + Flux automation stack](https://www.runpod.io/articles/guides/comfy-ui-flux)
