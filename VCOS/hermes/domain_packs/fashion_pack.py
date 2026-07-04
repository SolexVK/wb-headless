"""VCOS — Fashion Domain Pack v1

Изолирует знания модной съёмки и fashion-контента:
- вопросы про стиль одежды, позу, концепцию
- дефолтные ограничения для fashion
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint
)


class FashionPack(DomainPack):
    """Знания модной съёмки: стиль, поза, концепция, бренд."""

    name = "fashion"
    domains = ["fashion", "мода", "lookbook", "editorial", "streetstyle",
               "показ", "коллекция", "одежда"]
    requires_knowledge = ["photography", "lighting"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        questions = [
            DomainQuestion(
                block="intent", field="concept",
                text="👗 **Концепция**\n\nКакая идея коллекции или образа?",
                examples=["Urban minimalism / Romantic vintage / Tech wear"],
            ),
            DomainQuestion(
                block="model", field="model_type",
                text="🧑 **Модель**\n\nТип модели, настроение, ракурс.",
                examples=[
                    "Женщина, уверенная, dynamic pose",
                    "Мужчина, спокойный, editorial stare",
                ],
            ),
            DomainQuestion(
                block="style", field="garment_focus",
                text="🧥 **Фокус на одежде**\n\nЧто в центре — материал, крой, цвет?",
                examples=["Текстура: шерсть / Силуэт: oversize / Цвет: кислотный"],
            ),
            DomainQuestion(
                block="environment", field="location",
                text="📍 **Локация**\n\nСтудия/улица/интерьер/абстрактный фон?",
                examples=["Студия, белый цилиндр, драматический свет",
                          "Урбан, граффити, золотой час"],
            ),
            DomainQuestion(
                block="composition", field="pose",
                text="💃 **Поза**\n\nКак стоит/движется модель?",
                examples=["Динамичная, развевающиеся волосы",
                          "Спокойная, взгляд в камеру"],
            ),
            DomainQuestion(
                block="color", field="palette",
                text="🎨 **Цветовая палитра**\n\nСочетание цветов одежды и фона.",
                examples=["Монохром: total black / Контраст: красный + зелёный"],
                required=False,
            ),
        ]
        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        return [
            DomainConstraint(
                description="Фокус на одежде: одежда занимает не менее 60% кадра",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Выражение модели соответствует настроению коллекции",
                constraint_type="must_have",
            ),
        ]

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {
                "aspect_ratio": "2:3",
                "style": "editorial, high fashion, textured, studio soft lighting",
            },
            "midjourney": {
                "ar": "2:3",
                "style": "--ar 2:3 --style raw",
                "keywords": "editorial, high fashion, textured, dramatic lighting",
            },
            "sdxl": {
                "width": 832,
                "height": 1216,
                "style": "editorial, high fashion, textured",
            },
        }
        return hints.get(model, {})