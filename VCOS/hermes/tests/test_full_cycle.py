"""VCOS — Integration tests: full cognitive cycle (requires LLM)

Проверяет, как система мыслит и оценивает вероятности
на реальных LLM-вызовах.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

import pytest
from hermes.orchestrator.core import Orchestrator


class TestFullCycle:
    """Полный когнитивный цикл: все фазы 0→6."""

    def test_full_cycle_advance(self):
        """Система проходит все фазы и экспортирует промпт."""
        o = Orchestrator()
        o.start_new_session()

        assert o.submit_answer("одежда")["type"] == "question"

        r = o.submit_answer(
            "Рубашка оверсайз, голубая, ткань Оксфорд, "
            "прямой крой, отложной воротник, длинный рукав, на пуговицах"
        )
        assert r["type"] == "question"

        r = o.submit_answer(
            "Девушка 25 лет, блондинка, рубашка надета, джинсы, "
            "сумка через плечо. Съёмка на улице, кафе, солнечный день"
        )
        assert r["type"] == "question"

        r = o.submit_answer("нет")
        assert r["type"] == "question"

        r = o.submit_answer("нет")  # constraints — пропустить
        assert r["type"] == "question"

        r = o.submit_answer("харари")
        assert r["type"] == "question"

        r = o.submit_answer(
            "Настроение тёплое, стиль естественный, "
            "освещение золотистый свет, ракурс на уровне глаз, средний план"
        )
        assert r["type"] in ("question", "info")

        # Inference
        r = o.submit_answer("")
        # Может быть clarify или model question
        assert r["type"] in ("question", "info")

        # Export (если попали на clarify — модель всё равно уйдёт в экспорт)
        r = o.submit_answer("chatgpt")
        assert r["type"] == "done"
        assert len(r["prompt"]) > 100
        assert o.registry.node_count > 5

    def test_confidence_progression(self):
        """Уверенность растёт по мере заполнения блоков."""
        o = Orchestrator()
        o.start_new_session()

        # После категории
        conf_before = o.evaluator.overall_confidence()

        o.submit_answer("одежда")
        o.submit_answer(
            "Рубашка оверсайз, голубая, ткань Оксфорд, "
            "прямой крой, отложной воротник, длинный рукав"
        )
        conf_after_product = o.evaluator.overall_confidence()

        o.submit_answer(
            "Девушка 25 лет, блондинка. Улица, кафе"
        )
        conf_after_model = o.evaluator.overall_confidence()

        o.submit_answer("нет")
        o.submit_answer("нет")  # constraints — пропустить
        o.submit_answer("харари")
        o.submit_answer(
            "Тёплое настроение, естественный стиль, золотистый свет"
        )

        conf_final = o.evaluator.overall_confidence()

        # Уверенность должна расти
        assert conf_after_product >= conf_before, \
            f"{conf_after_product} >= {conf_before}"
        print(f"  Confidence: {conf_before:.2f} → {conf_after_product:.2f} "
              f"→ {conf_after_model:.2f} → {conf_final:.2f}")

    def test_model_switch(self):
        """После экспорта можно переключить модель."""
        o = Orchestrator()
        o.start_new_session()
        o.submit_answer("одежда")
        o.submit_answer("Чёрное платье, трикотаж, миди, круглый вырез")
        o.submit_answer("Модель брюнетка. Студия, серый фон")
        o.submit_answer("нет")
        o.submit_answer("нет")  # constraints — пропустить
        o.submit_answer("кубрик")
        o.submit_answer("Загадочное настроение, контрастный свет, ракурс снизу")
        o.submit_answer("")
        o.submit_answer("midjourney")

        # Переключение
        r = o.switch_model("sdxl")
        assert r["type"] == "done"
        assert len(r["prompt"]) > 100


def _llm_available() -> bool:
    """LLM доступна только при наличии API-ключа."""
    try:
        from hermes.domain_packs.llm_client import get_api_key
        return bool(get_api_key())
    except Exception:
        return False


@pytest.mark.skipif(not _llm_available(),
                    reason="Требует LLM API-ключ (OPENROUTER_API_KEY)")
class TestDialogueParsing:
    """Парсинг ответов LLM (требует DeepSeek API)."""

    def test_parse_product(self):
        from hermes.agents.dialogue_agent import DialogueAgent
        d = DialogueAgent()
        r = d.parse("product",
                     "Рубашка оверсайз, голубая, ткань Оксфорд, "
                     "прямой крой, отложной воротник, длинный рукав")
        assert len(r.fields) > 0, f"Парсинг не дал полей: {r.error}"
        # Должны быть минимум type, color, material
        assert any(k in r.fields for k in ["type", "color", "material"]), \
            f"Нет базовых полей: {list(r.fields.keys())}"
        assert r.confidence > 0, "Уверенность должна быть > 0"

    def test_parse_model_scene(self):
        from hermes.agents.dialogue_agent import DialogueAgent
        d = DialogueAgent()
        r = d.parse("model_scene",
                     "Девушка 25 лет, блондинка, рубашка, джинсы, "
                     "сумка. Улица, кафе, солнечный день")
        assert len(r.fields) > 0
        assert any(k in r.fields for k in ["identity", "location"]), \
            f"Нет базовых полей: {list(r.fields.keys())}"

    def test_parse_direction(self):
        from hermes.agents.dialogue_agent import DialogueAgent
        d = DialogueAgent()
        r = d.parse("direction",
                     "Тёплое настроение, естественный стиль, "
                     "золотистый свет, уровень глаз, средний план")
        assert len(r.fields) > 0
        assert any(k in r.fields for k in ["mood", "style", "lighting"]), \
            f"Нет базовых полей: {list(r.fields.keys())}"


class TestProfileSelection:
    """Выбор профиля из 22 доступных."""

    def test_all_profiles_accessible(self):
        from hermes.design.director_profiles import ALL_PROFILES
        assert len(ALL_PROFILES) >= 22, f"Ожидается ≥22 профиля, есть {len(ALL_PROFILES)}"

    def test_profile_applies_recommendations(self):
        from hermes.design.visual_reasoner import VisualReasoner
        v = VisualReasoner()
        suggestions = v.apply_profile("Кристофер Нолан")
        # Должны быть рекомендации по композиции, свету, цвету
        blocks = set(s.block for s in suggestions)
        assert len(blocks) >= 2, f"Ожидается ≥2 блоков, есть {blocks}"

    def test_profile_by_role(self):
        from hermes.design.director_profiles import list_profiles_by_role
        groups = list_profiles_by_role()
        assert len(groups) == 3, f"Ожидается 3 группы, есть {len(groups)}"
        for name, profiles in groups.items():
            assert len(profiles) >= 3, f"Группа {name}: всего {len(profiles)} профилей"
        filmmakers = list(groups.values())[0]
        designers = list(groups.values())[1]
        marketers = list(groups.values())[2]
        assert len(filmmakers) >= 10
        assert len(designers) >= 3
        assert len(marketers) >= 5


class TestExporters:
    """Все 5 форматов экспорта."""

    def test_all_formats_export(self):
        from hermes.renderers.prompt_exporter import PromptExporter, ReferenceSlot
        data = {
            "intent": "type: рубашка; color: голубая",
            "character": "identity: девушка 25 лет",
            "mood": "тёплое",
            "category": "одежда",
        }
        exporter = PromptExporter()
        for model in ["chatgpt", "midjourney", "nanobanana", "flux", "sdxl"]:
            prompt = exporter.export(data, model)
            assert len(prompt) > 50, f"{model}: промпт слишком короткий ({len(prompt)})"

    def test_exporter_different_syntax(self):
        """Каждый формат имеет уникальный синтаксис."""
        from hermes.renderers.prompt_exporter import PromptExporter
        data = {"intent": "рубашка"}
        exporter = PromptExporter()
        mj = exporter.export(data, "midjourney")
        chat = exporter.export(data, "chatgpt")
        assert "TECHNICAL SPECIFICATION" in chat
        assert "--ar" in mj or "--v" in mj


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])