"""VCOS — Photography Domain Pack v1

Изолирует знания предметной фотосъёмки:
- вопросы про товар, модель, сцену, свет, композицию
- дефолтные ограничения для разных платформ (WB, Ozon)
- подсказки для рендера

Insight #7: Доменные знания вне ядра.
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint, DomainPackManifest
)


class PhotographyPack(DomainPack):
    """Знания предметной фотосъёмки для WB / каталогов / рекламы."""

    name = "photography"
    domains = ["photography", "product-photography"]
    requires_knowledge = ["photography", "lighting"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        ctx = context or {}
        product_type = ctx.get("product_type", "")

        questions = [
            DomainQuestion(
                block="intent", field="product_type",
                text="📦 **Что снимаем?**\n\nОпиши товар: что это, цвет, материал, форма.",
                examples=["Рубашка оверсайз, голубая, ткань Оксфорд"],
            ),
            DomainQuestion(
                block="character", field="model",
                text="👤 **Модель и окружение**\n\nКто на фото? Где снимаем?",
                examples=["Девушка 25 лет, блондинка. Кафе, солнечный день"],
            ),
        ]

        if product_type == "одежда":
            questions.append(
                DomainQuestion(
                    block="camera", field="lens",
                    text="📷 **Объектив**\n\nВ полный рост или детали?",
                    examples=["85-105mm для полного роста", "50mm для деталей"],
                )
            )
            questions.append(
                DomainQuestion(
                    block="composition", field="rule_of_thirds",
                    text="🎯 **Композиция**\n\nОбъект по центру или смещён?",
                    required=False,
                )
            )

        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        ctx = context or {}
        platform = ctx.get("platform", "wb")

        constraints = [
            DomainConstraint(
                description="Фотореалистичный стиль, без художественных искажений",
                constraint_type="must_have",
            ),
        ]

        if platform == "wb":
            constraints.append(
                DomainConstraint(
                    description="Белый фон, товар в фокусе, без отвлекающих деталей",
                    constraint_type="must_have",
                )
            )
            constraints.append(
                DomainConstraint(
                    description="Соотношение 1:1 для карточки, 3:4 для галереи",
                    constraint_type="must_have",
                )
            )

        return constraints

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {"aspect_ratio": "1:1", "style": "photorealistic"},
            "midjourney": {"ar": "1:1", "style": "--ar 1:1 --style raw"},
            "sdxl": {"width": 1024, "height": 1024},
        }
        return hints.get(model, {})