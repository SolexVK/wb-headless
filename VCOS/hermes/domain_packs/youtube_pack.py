"""VCOS — YouTube Domain Pack v1

Изолирует знания видео-контента YouTube/Short/Reels:
- вопросы про формат видео, жанр, хронометраж
- настройки для разных платформ
"""

from typing import List, Optional

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint
)


class YouTubePack(DomainPack):
    """Знания видео-контента: YouTube, Shorts, Reels, TikTok."""

    name = "youtube"
    domains = ["youtube", "video", "short", "reels", "tiktok", "стрим",
               "обзор", "туториал", "влог"]

    def get_questions(self, context: Optional[dict] = None) -> List[DomainQuestion]:
        questions = [
            DomainQuestion(
                block="intent", field="format",
                text="🎬 **Формат видео**\n\nКакое это видео?",
                examples=["Shorts/TikTok (до 60с) / Full-length (10-20мин) / Поток"],
            ),
            DomainQuestion(
                block="intent", field="genre",
                text="🎭 **Жанр**\n\nОбзор/туториал/влог/скетч/реакция?",
                examples=["Кулинарный туториал / Обзор техники / Дневник путешествий"],
            ),
            DomainQuestion(
                block="audience", field="target_viewer",
                text="👥 **Целевая аудитория**\n\nКто будет смотреть?",
                examples=["Геймеры 18-25 / Домохозяйки 30-50 / IT-специалисты"],
            ),
            DomainQuestion(
                block="style", field="mood",
                text="🎭 **Настроение**\n\nДинамичный/спокойный/юмористический/серьёзный?",
                examples=["Быстрый монтаж, энергичная музыка",
                          "Размеренный, ASMR, без музыки"],
            ),
            DomainQuestion(
                block="color", field="brand_colors",
                text="🎨 **Цветокоррекция**\n\nТёплая/холодная/натуральная/киношная?",
                examples=["Тёплая, как у кулинарных блогов",
                          "High contrast, как у обзоров техники"],
                required=False,
            ),
            DomainQuestion(
                block="composition", field="framing",
                text="📐 **Кадрирование**\n\nКак построен кадр?",
                examples=["Крупный план лица + товар в руках",
                          "Средний план, человек + фон/локация"],
            ),
        ]
        return questions

    def get_constraints(self, context: Optional[dict] = None) -> List[DomainConstraint]:
        return [
            DomainConstraint(
                description="Соотношение сторон: 9:16 для Shorts/TikTok, 16:9 для full-length",
                constraint_type="must_have",
            ),
            DomainConstraint(
                description="Хронометраж Shorts не более 60 секунд",
                constraint_type="must_have",
            ),
        ]

    def get_render_hints(self, model: str) -> dict:
        hints = {
            "chatgpt": {
                "aspect_ratio": "9:16",
                "style": "dynamic, engaging, direct-to-camera, video thumbnail",
            },
            "midjourney": {
                "ar": "9:16",
                "style": "--ar 9:16 --style raw",
                "keywords": "dynamic, engaging, direct-to-camera",
            },
            "sdxl": {
                "width": 832,
                "height": 1216,
                "style": "dynamic, engaging, direct-to-camera",
            },
        }
        return hints.get(model, {})