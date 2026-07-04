"""VCOS — Film Domain Pack v1

Изолирует знания кинематографической съёмки:
- вопросы про формат, жанр, сцену, настроение
- дефолтные ограничения кино-производства
- подсказки для рендера в кинематографическом стиле

Insight #7: Доменные знания вне ядра.
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint, DomainPackManifest
)


class FilmPack(DomainPack):
    """Знания кинематографической съёмки: кадр, жанр, формат, настроение."""

    name = "film"
    domains = ["film", "cinema", "movie", "кинематограф", "кино", "фильм"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        ctx = context or {}
        genre = ctx.get("genre", "")

        questions = [
            DomainQuestion(
                block="intent", field="genre",
                text="🎬 **Какой жанр?**\n\nЧто снимаем? Драма, комедия, экшн, нуар, фэнтези?",
                examples=["Драма с элементами нуара", "Светлая романтическая комедия"],
            ),
            DomainQuestion(
                block="intent", field="format",
                text="📽 **Формат съёмки**\n\nЦифра или плёнка? Соотношение сторон?",
                examples=["Цифровой 4K, 16:9", "Плёнка 35mm, анаморф 2.35:1"],
            ),
            DomainQuestion(
                block="character", field="scene_type",
                text="🏙 **Локация**\n\nГде происходит сцена? Интерьер или экстерьер? День или ночь?",
                examples=["Ночной Нью-Йорк, неон", "Золотой час в поле пшеницы"],
            ),
            DomainQuestion(
                block="atmosphere", field="mood",
                text="🌫 **Настроение сцены**\n\nКакая атмосфера? Напряжение, уют, тревога, мечта?",
                examples=["Гнетущее ожидание, скоро что-то случится"],
            ),
            DomainQuestion(
                block="style", field="period",
                text="⏳ **Временной период**\n\nСовременность или исторический? Какая эпоха?",
                examples=["1970-е, винтаж", "Киберпанк-будущее 2088"],
                required=False,
            ),
            DomainQuestion(
                block="color", field="color_grading",
                text="🎨 **Цветовое решение**\n\nХолодная драма или тёплая ностальгия?",
                examples=["Teal & orange, как в блокбастерах", "Bleach bypass, выбеленные тона"],
                required=False,
            ),
        ]

        # Дополнительные вопросы по жанру
        genre_lower = genre.lower()
        if "экшн" in genre_lower or "боевик" in genre_lower or "триллер" in genre_lower:
            questions.append(
                DomainQuestion(
                    block="motion", field="camera_movement",
                    text="🎥 **Динамика**\n\nКамера статична или в движении? Экшн-сцена или диалог?",
                    examples=["Handheld, адреналиновый темп", "Steadicam, плавное преследование"],
                )
            )
        elif "нуар" in genre_lower or "детектив" in genre_lower:
            questions.append(
                DomainQuestion(
                    block="lighting", field="light_signature",
                    text="💡 **Свет**\n\nНуар-освещение с жёсткими тенями?",
                    examples=["Rembrandt light, жалюзи, тени", "High contrast, один источник"],
                )
            )

        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        ctx = context or {}
        genre = ctx.get("genre", "")

        constraints = [
            DomainConstraint(
                description="Кинематографическое качество: глубина резкости, боке, кинематографический цвет",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Соотношение сторон 2.35:1 или 16:9 для кинематографического кадра",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Letterbox/chambord для широкоэкранного эффекта",
                constraint_type="must_have",
            ),
        ]

        genre_lower = genre.lower()
        if "нуар" in genre_lower or "детектив" in genre_lower:
            constraints.append(
                DomainConstraint(
                    description="Высокий контраст, жёсткие тени, силуэты, минимум полутеней",
                    constraint_type="must_have",
                )
            )
        elif "комедия" in genre_lower:
            constraints.append(
                DomainConstraint(
                    description="Яркая, насыщенная палитра, открытые улыбки, светлые тона",
                    constraint_type="must_have",
                )
            )

        return constraints

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {
                "aspect_ratio": "16:9",
                "style": "cinematic, film still, professional lighting, depth of field",
            },
            "midjourney": {
                "ar": "16:9",
                "style": "--ar 16:9 --style raw --s 300",
                "keywords": "cinematic lighting, film grain, anamorphic",
            },
            "sdxl": {
                "width": 1216,
                "height": 832,
                "style": "cinematic, film still",
                # Кино допускает мрачные сцены — не подавляем их дефолтным negative
                "negative": "deformed hands, extra fingers, low quality, "
                            "blurry, illustration, cartoon, 3d render, watermark",
            },
            "flux": {
                "aspect_ratio": "16:9",
                "style": "cinematic, film grain, anamorphic lens",
            },
        }
        return hints.get(model, {})