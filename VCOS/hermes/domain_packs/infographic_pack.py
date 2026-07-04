"""VCOS — Infographic Domain Pack v1

Изолирует знания инфографики и презентаций:
- вопросы про формат, стиль, данные, сторителлинг
- дефолтные ограничения для разных типов инфографики
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint
)


class InfographicPack(DomainPack):
    """Знания инфографики и презентаций: формат, стиль, данные, сторителлинг."""

    name = "infographic"
    domains = ["infographic", "presentation", "data-viz"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        questions = [
            DomainQuestion(
                block="intent", field="purpose",
                text="📊 **Цель инфографики**\n\nЧто должна донести графика?",
                examples=["Объяснить процесс / Показать статистику / Сравнить данные"],
            ),
            DomainQuestion(
                block="audience", field="viewer",
                text="👥 **Аудитория**\n\nКто будет смотреть? Уровень подготовки.",
                examples=["Руководители / Школьники / Широкая публика"],
            ),
            DomainQuestion(
                block="style", field="narrative_style",
                text="🎨 **Стиль повествования**\n\nХронология, сравнение, проблема-решение?",
                examples=["A → B → C, пошаговый процесс",
                          "Слева-направо, сравнение 'до/после'"],
            ),
            DomainQuestion(
                block="color", field="color_palette",
                text="🎨 **Цветовая палитра**\n\nКакие цвета доминируют?",
                examples=["Корпоративные цвета бренда",
                          "Контрастные: синий + оранжевый"],
            ),
            DomainQuestion(
                block="composition", field="layout",
                text="📐 **Компоновка**\n\nВертикальная/горизонтальная? Секции?",
                examples=["Сверху-вниз, 3 блока с иконками",
                          "Постер, 70% графика + 30% текст"],
            ),
            DomainQuestion(
                block="typography", field="font_style",
                text="🔤 **Шрифты**\n\nЕсть предпочтения по шрифтам?",
                examples=["Гротеск, жирный для заголовков",
                          "Минималистичный, тонкий"],
                required=False,
            ),
        ]
        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        return [
            DomainConstraint(
                description="Читаемость текста: текст не меньше 11px, контрастный фон",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Иерархия: заголовок > подзаголовок > тело > подпись",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Ясность диаграмм: не более 5 цветов на одной диаграмме",
                constraint_type="must_have",
            ),
        ]

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {
                "aspect_ratio": "16:9",
                "style": "clean, data-driven, minimal shadows, flat design",
            },
            "midjourney": {
                "ar": "16:9",
                "style": "--ar 16:9 --style raw",
                "keywords": "clean infographic, data-driven, minimal shadows",
            },
            "sdxl": {
                "width": 1216,
                "height": 832,
                "style": "clean, data-driven, minimal shadows",
            },
        }
        return hints.get(model, {})