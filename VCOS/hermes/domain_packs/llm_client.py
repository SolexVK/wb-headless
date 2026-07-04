"""
VCOS — LLM Client for OpenRouter API

Используется Dialogue Transformer для генерации вопросов
и интерпретации ответов через LLM (DeepSeek V4 Flash / Nemotron FREE).

Структура 10 слоёв проработки промпта:
1. location     — Локация
2. era          — Эпоха/время суток
3. mood         — Настроение
4. subjects     — Персонажи
5. blocking     — Расположение в кадре
6. camera_dist  — Дистанция камеры
7. depth_of_field — Резкость/фон
8. lighting_type — Освещение
9. color_palette — Цвета
10. film_format  — Формат/плёнка
"""

import json
import logging
import os
import urllib.request
import urllib.error
from typing import Optional, List

logger = logging.getLogger(__name__)

# Модели с возможностью override через env
DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
DEFAULT_FALLBACK_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

MODELS = [
    os.environ.get("VCOS_LLM_MODEL", DEFAULT_MODEL),
    os.environ.get("VCOS_LLM_FALLBACK", DEFAULT_FALLBACK_MODEL),
]

DEFAULT_TIMEOUT = 15

LAYERS = [
    "location", "era", "mood", "subjects", "blocking",
    "camera_angle", "camera_dist", "lens_type", "depth_of_field",
    "background", "props", "lighting_type", "color_palette", "color_contrast",
    "film_format",
]

LAYER_NAMES = {
    "location": "Локация и место",
    "era": "Эпоха и время суток",
    "mood": "Настроение",
    "subjects": "Персонажи",
    "blocking": "Расположение в кадре",
    "camera_angle": "Угол камеры",
    "camera_dist": "Дистанция до объекта",
    "lens_type": "Тип оптики и линз",
    "depth_of_field": "Резкость и размытие фона",
    "background": "Фон и окружение",
    "props": "Предметы и реквизит",
    "lighting_type": "Освещение",
    "color_palette": "Цветовая палитра",
    "color_contrast": "Контраст и цветовые акценты",
    "film_format": "Формат, плёнка и зерно",
}


def get_api_key() -> Optional[str]:
    """Ключ API: сначала из окружения, потом из ~/.hermes/.env."""
    for var in ("OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"):
        key = os.environ.get(var, "").strip()
        if key:
            return key

    env_path = os.path.expanduser("~/.hermes/.env")
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("#"):
                    continue
                if "OPENROUTER_API_KEY=" in line or "DEEPSEEK_API_KEY=" in line:
                    return line.split("=", 1)[1].strip("\"'")
    except OSError:
        return None
    return None


def call_llm(system_prompt: str, user_prompt: str, model: Optional[str] = None, timeout: int = 30, max_tokens: int = 600) -> Optional[str]:
    api_key = get_api_key()
    if not api_key:
        return None
    
    import time
    models_to_try = [model] if model else MODELS
    
    for model_name in models_to_try:
        if not model_name:
            continue

        payload = json.dumps({
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.7,
            "max_tokens": max_tokens,
        }).encode("utf-8")
        
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://vcos.hermes.local",
            },
            method="POST",
        )
        
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                if content:
                    return content
                logger.warning("LLM %s вернул пустой ответ, пробуем следующую модель",
                               model_name)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                logger.warning("LLM %s: rate limit (429), пауза и следующая модель",
                               model_name)
                time.sleep(2)  # sleep только после 429
                continue
            logger.warning("LLM %s: HTTP %s: %s", model_name, e.code, e.reason)
            return None
        except Exception as e:
            logger.warning("LLM %s: запрос не удался (%s: %s), пробуем следующую модель",
                           model_name, type(e).__name__, e)
            continue

    return None


def _extract_json(text: str) -> Optional[dict]:
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end+1])
        return json.loads(text)
    except (json.JSONDecodeError, KeyError):
        return None


def generate_question(
    state_summary: str,
    covered_layers: List[str],
    questions_asked: int,
    max_questions: int,
) -> Optional[dict]:
    """Попросить LLM задать 1 вопрос по самому важному непокрытому слою."""
    uncovered = [l for l in LAYERS if l not in covered_layers]
    if not uncovered:
        return None
    
    uncovered_names = [LAYER_NAMES.get(l, l) for l in uncovered]
    
    system = f"""Ты — ассистент-режиссёр. Помогаешь спроектировать изображение.

15 слоёв сцены (в порядке приоритета):
1. location — место (где происходит)
2. era — эпоха/время суток (утро/ночь/80-е)
3. mood — настроение (уют/тревога/спокойствие)
4. subjects — персонажи (кто, сколько, внешность)
5. blocking — расположение в кадре (лицом/через плечо)
6. camera_angle — угол камеры (уровень глаз/сверху/снизу)
7. camera_dist — дистанция (крупно/средне/издалека)
8. lens_type — тип оптики (сферический/анаморф/винтаж)
9. depth_of_field — резкость фона (размытый/чёткий)
10. background — фон/окружение (что на заднем плане)
11. props — предметы/реквизит (что ещё в кадре)
12. lighting_type — свет (мягкий/резкий/тёплый)
13. color_palette — цвета (тёплые/холодные/приглушённые)
14. color_contrast — контраст и акценты
15. film_format — формат/плёнка/зерно

ПРАВИЛА:
- Выбери самый важный НЕПОКРЫТЫЙ слой из: {', '.join(uncovered_names)}
- Один вопрос = ровно один слой
- Без терминов, человеческим языком, на русском
- 2-4 коротких варианта ответа

Формат (строго JSON):
{{"layer": "location", "question": "текст", "options": ["вар1", "вар2"]}}"""

    user = f"""Состояние проекта:
{state_summary}

Покрыто: {', '.join(covered_layers) if covered_layers else 'нет'}
Осталось: {max_questions - questions_asked}

Вопрос для самого важного непокрытого слоя:"""

    content = call_llm(system, user)
    if not content:
        return None
    
    result = _extract_json(content)
    if not result or "layer" not in result or result["layer"] not in LAYERS:
        result = {"layer": uncovered[0], "question": "Расскажи подробнее о сцене?", "options": []}
    
    return result


def interpret_answer(
    question: str,
    answer: str,
    layer: str,
) -> Optional[dict]:
    """Интерпретировать ответ. 1 ответ = 1 решение (без дублей)."""
    system = f"""Ты — ассистент-режиссёр. Интерпретируй ответ пользователя.

Слой: {layer}

ПРАВИЛА:
- Ровно 1 решение (не больше)
- РЕШЕНИЕ НА РУССКОМ ЯЗЫКЕ (коротко, для промпта)
- 1-2 коротких факта на русском

Формат (строго JSON):
{{
  "facts": ["1 факт из ответа (на русском)"],
  "decision": {{"value": "технический параметр НА РУССКОМ для промпта", "confidence": 0.85}},
  "confidence_delta": 0.15
}}"""

    user = f"""Вопрос: {question}
Ответ: {answer}
Слой: {layer}"""

    content = call_llm(system, user)
    if not content:
        return None
    
    return _extract_json(content)