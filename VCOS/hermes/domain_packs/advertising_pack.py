"""VCOS — Advertising Domain Pack v1

Изолирует знания рекламной и коммерческой съёмки:
- вопросы про платформу, аудиторию, CTA, бренд
- дефолтные ограничения для разных платформ (WB, Ozon, Instagram)
- подсказки для рендера в коммерческом стиле

Insight #7: Доменные знания вне ядра.
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint, DomainPackManifest
)


class AdvertisingPack(DomainPack):
    """Знания рекламной съёмки: платформа, ЦА, CTA, бренд, конверсия."""

    name = "advertising"
    domains = ["advertising", "ads", "commercial", "реклама", "маркетинг",
               "wb", "wildberries", "ozon", "marketplace"]
    requires_knowledge = ["photography", "lighting"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        ctx = context or {}
        platform = ctx.get("platform", "")
        product_type = ctx.get("product_type", "")

        questions = [
            DomainQuestion(
                block="intent", field="platform",
                text="📱 **Платформа для размещения**\n\nГде будет использоваться фото?",
                examples=["Wildberries / Ozon / Instagram / билборд"],
            ),
            DomainQuestion(
                block="intent", field="audience",
                text="👥 **Целевая аудитория**\n\nКто ваш клиент? Возраст, пол, стиль жизни.",
                examples=["Женщины 25-45, заботятся о семье и доме",
                          "Молодые парни 18-30, следят за трендами"],
            ),
            DomainQuestion(
                block="style", field="cta",
                text="🎯 **Цель кадра**\n\nЧто пользователь должен почувствовать или сделать?",
                examples=["Купить «в корзину» сейчас", "Запомнить бренд, доверие"],
            ),
            DomainQuestion(
                block="color", field="brand_colors",
                text="🏷 **Цвета бренда**\n\nЕсть фирменные цвета?",
                examples=["Красный + белый, строго по брендбуку", "Нет, свободная палитра"],
                required=False,
            ),
        ]

        platform_lower = platform.lower()
        if "wb" in platform_lower or "wildberries" in platform_lower:
            questions.append(
                DomainQuestion(
                    block="composition", field="product_focus",
                    text="📦 **Фокус на товаре**\n\nТовар в центре или в контексте использования?",
                    examples=["Чистый белый фон, товар в центре кадра"],
                )
            )
            questions.append(
                DomainQuestion(
                    block="composition", field="aspect_ratio",
                    text="📐 **Соотношение сторон**\n\n1:1 для карточки или 3:4 для галереи?",
                    examples=["1:1 основное, 3:4 для ленты"],
                    required=False,
                )
            )
        elif "instagram" in platform_lower:
            questions.append(
                DomainQuestion(
                    block="composition", field="lifestyle",
                    text="🌿 **Lifestyle или product shot?**\n\nТовар в жизни или строгий предметный снимок?",
                    examples=["Lifestyle: девушка пьёт кофе на балконе", "Product shot: товар на мраморной столешнице"],
                )
            )

        if product_type and product_type != "":
            if product_type == "одежда":
                questions.append(
                    DomainQuestion(
                        block="character", field="model",
                        text="🧑 **Модель**\n\nКто демонстрирует товар?",
                        examples=["Девушка 25 лет, на улице, солнечный день"],
                    )
                )

        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        ctx = context or {}
        platform = ctx.get("platform", "")

        constraints = [
            DomainConstraint(
                description="Товар в фокусе, без отвлекающих элементов",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Фотореалистичный стиль, без художественных искажений",
                constraint_type="must_have",
            ),
        ]

        platform_lower = platform.lower()
        if "wb" in platform_lower or "wildberries" in platform_lower:
            constraints.append(
                DomainConstraint(
                    description="Белый или очень светлый фон, товар занимает 70-80% кадра",
                    constraint_type="must_have",
                )
            )
            constraints.append(
                DomainConstraint(
                    description="Минимум теней, читаемая текстура, формат 1:1 или 3:4",
                    constraint_type="must_have",
                )
            )
        elif "ozon" in platform_lower:
            constraints.append(
                DomainConstraint(
                    description="Чистый фон, допустим лёгкий контекст (стол, стул), товар в центре",
                    constraint_type="must_have",
                )
            )
        elif "instagram" in platform_lower:
            constraints.append(
                DomainConstraint(
                    description="Эстетичный, lifestyle-стиль, квадратный 1:1 или вертикальный 4:5",
                    constraint_type="must_have",
                )
            )

        return constraints

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {
                "aspect_ratio": "1:1",
                "style": "commercial product photography, professional lighting, clean background",
            },
            "midjourney": {
                "ar": "1:1",
                "style": "--ar 1:1 --style raw --s 200",
                "keywords": "commercial, product photography, studio lighting",
            },
            "sdxl": {
                "width": 1024,
                "height": 1024,
                "style": "commercial photography, product shot",
            },
        }
        return hints.get(model, {})