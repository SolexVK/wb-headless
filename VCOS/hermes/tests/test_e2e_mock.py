"""VCOS — Integration test: full e2e cycle with LLM mocked

Проверяет полный когнитивный цикл без реального LLM.
Все LLM-вызовы (call_llm) замоканы на controlled responses.

Покрывает:
  - Фазу 0-6 (все 7 фаз)
  - Creative Strategy (новая фаза 31)
  - Export
  - Domain Pack selection
  - Snapshot generation
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

import json
from unittest.mock import patch, Mock


# ─── Mock response for LLM calls ──────────────────────────────

def _mock_llm_response(system_prompt: str, user_prompt: str,
                       model=None, timeout=30, max_tokens=600):
    """Mock для call_llm — возвращает controlled JSON в зависимости от контекста."""
    # Scene Discovery Engine: next_question
    if "Scene Discovery" in (system_prompt or "") or "maximally reduce uncertainty" in user_prompt:
        return json.dumps({
            "block": "composition",
            "question": "Какая композиция лучше подойдёт?",
            "reasoning": "Композиция — следующий важный элемент",
        })
    # Dialogue parse: direction / creative_strategy
    if "Извлеки информацию" in user_prompt or "Поля для заполнения" in user_prompt:
        # Определяем какие поля нужны
        if "core_idea" in user_prompt:
            return json.dumps({
                "core_idea": "Статус через сдержанность",
                "approach": "Минимализм, много воздуха",
                "target_emotion": "Уверенность",
                "visual_metaphor": "Остров в океане",
            })
        return json.dumps({
            "type": "рубашка",
            "color": "синяя",
            "material": "хлопок",
        })
    # Fallback
    return json.dumps({"text": "тестовый ответ"})


def test_e2e_full_cycle_with_mock():
    """Полный e2e цикл с замоканным LLM."""
    with patch("hermes.domain_packs.llm_client.call_llm", side_effect=_mock_llm_response):
        from hermes.orchestrator.core import Orchestrator

        o = Orchestrator()

        # ─── Фаза 0: Category ────────────────────────────────
        res = o.start_new_session()
        assert res["type"] == "question"
        assert o.state.status == "active"

        res = o.submit_answer("одежда")
        assert res["type"] == "question"
        assert o._current_category == "одежда"

        # ─── Фаза 1: Product ─────────────────────────────────
        res = o.submit_answer("Рубашка оверсайз, синяя, хлопок")
        assert res["type"] == "question"

        # ─── Фаза 2: Model + Scene ───────────────────────────
        res = o.submit_answer("Девушка 25 лет, на улице, солнечный день")
        assert res["type"] == "question"

        # ─── Референс (skip) ─────────────────────────────────
        res = o.submit_answer("нет")
        assert res["type"] == "question"

        # ─── Ограничения (skip) ──────────────────────────────
        res = o.submit_answer("")
        assert res["type"] == "question"

        # ─── Профиль ─────────────────────────────────────────
        res = o.submit_answer("харари")
        assert res["type"] == "question"
        assert o._current_profile is not None

        # ─── Фаза 3: Direction ───────────────────────────────
        res = o.submit_answer("Настроение тёплое, стиль естественный, освещение золотистое")
        assert res["type"] == "question"
        assert o._phase == 31  # Creative Strategy

        # ─── Фаза 31: Creative Strategy ──────────────────────
        res = o.submit_answer("Статус через сдержанность: минимум деталей, много воздуха")
        assert res["type"] in ("question", "info")
        assert o._phase == 4  # Inference

        # ─── Фаза 4: Inference ───────────────────────────────
        res = o.submit_answer("продолжить")
        if res["type"] == "done":
            assert "prompt" in res
            assert len(res["prompt"]) > 0
        else:
            # Если потребовалось уточнение — экспортируем
            assert res["type"] == "question"
            res = o.submit_answer("chatgpt")
            assert res["type"] == "done"
            assert "prompt" in res


def test_e2e_export_prompt_not_empty():
    """Экспортированный промпт не пустой."""
    with patch("hermes.domain_packs.llm_client.call_llm", side_effect=_mock_llm_response):
        from hermes.orchestrator.core import Orchestrator

        o = Orchestrator()
        o.start_new_session()

        # Полный цикл
        o.submit_answer("одежда")
        o.submit_answer("Рубашка синяя, хлопок")
        o.submit_answer("Девушка на улице, день")
        o.submit_answer("нет")
        o.submit_answer("")
        o.submit_answer("харари")
        o.submit_answer("Настроение тёплое")
        o.submit_answer("Статус через сдержанность")
        res = o.submit_answer("продолжить как есть")  # inference — может быть clarify
        if res["type"] == "question":
            # Clarify / model selection
            res = o.submit_answer("chatgpt")

        assert res["type"] == "done"
        assert len(res["prompt"]) > 10
        assert "🎬 Concept" in res["prompt"]
        assert "рубашка" in res["prompt"].lower()


def test_e2e_snapshots_created():
    """В процессе цикла создаются снэпшоты."""
    with patch("hermes.domain_packs.llm_client.call_llm", side_effect=_mock_llm_response):
        from hermes.orchestrator.core import Orchestrator

        o = Orchestrator()
        o.start_new_session("одежда")
        o.submit_answer("Рубашка синяя, хлопок")
        o.submit_answer("Девушка на улице, день")
        o.submit_answer("нет")
        o.submit_answer("")
        o.submit_answer("харари")
        o.submit_answer("Настроение тёплое")
        o.submit_answer("Статус через сдержанность")
        res = o.submit_answer("продолжить")
        if res["type"] == "question":
            o.submit_answer("chatgpt")

        hist = o.graph.snapshots.history()
        assert len(hist) >= 5  # минимум 5 снэпшотов


def test_e2e_decisions_recorded():
    """В процессе цикла записываются решения."""
    with patch("hermes.domain_packs.llm_client.call_llm", side_effect=_mock_llm_response):
        from hermes.orchestrator.core import Orchestrator

        o = Orchestrator()
        o.start_new_session()
        o.submit_answer("одежда")
        o.submit_answer("Рубашка синяя")
        o.submit_answer("Девушка на улице")
        o.submit_answer("нет")
        o.submit_answer("")
        o.submit_answer("харари")

        decisions = o.graph.logger.decisions
        assert len(decisions) >= 3


def test_e2e_domain_pack_auto_select():
    """Domain Pack автоматически подбирается по категории."""
    with patch("hermes.domain_packs.llm_client.call_llm", side_effect=_mock_llm_response):
        from hermes.orchestrator.core import Orchestrator

        o = Orchestrator()
        o.start_new_session("кино")
        assert o._active_domain_pack is not None
        assert o._active_domain_pack.name == "film"


def test_e2e_full_prompt_has_model_spec():
    """Готовый промпт содержит техническую спецификацию модели."""
    with patch("hermes.domain_packs.llm_client.call_llm", side_effect=_mock_llm_response):
        from hermes.orchestrator.core import Orchestrator

        o = Orchestrator()
        o.start_new_session("одежда")
        o.submit_answer("Рубашка синяя, хлопок")
        o.submit_answer("Девушка на улице, день")
        o.submit_answer("нет")
        o.submit_answer("")
        o.submit_answer("харари")
        o.submit_answer("Настроение тёплое")
        o.submit_answer("Статус через сдержанность")
        res = o.submit_answer("midjourney")
        if res["type"] == "question":
            res = o.submit_answer("midjourney")

        assert res["type"] == "done"
        if "prompt" in res:
            assert "--ar" in res["prompt"]
            assert "--v 6" in res["prompt"]