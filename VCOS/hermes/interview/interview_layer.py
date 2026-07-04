"""VCOS — Interview Layer v1

Отдельный слой интервью по CP-001 (Interview Protocol).

Контракт:
  start(session, context) → InterviewState
  ask(state) → Question[]
  collect(state, answers) → InterviewResult
  clarify(state, ambiguous) → Question[]
  abort(session) → void

Не зависит от LLM — только структура диалога и вопросы.
"""

from dataclasses import dataclass, field
from typing import Optional
from enum import Enum
from datetime import datetime


class QuestionType(str, Enum):
    CATEGORY = "category"
    PRODUCT = "product"
    MODEL_SCENE = "model_scene"
    REFERENCE = "reference"
    PROFILE = "profile"
    DIRECTION = "direction"
    MODEL_SELECT = "model"
    CLARIFY = "clarify"


@dataclass
class Question:
    """Один вопрос пользователю."""
    id: str
    text: str
    type: QuestionType
    phase: int
    options: Optional[list[str]] = None


@dataclass
class InterviewState:
    """Состояние интервью."""
    session_id: str
    current_phase: int = 0
    answered_questions: list[str] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: datetime.now().isoformat())
    category: str = ""


@dataclass
class InterviewResult:
    """Результат сбора ответов."""
    intents: dict = field(default_factory=dict)
    fields: dict = field(default_factory=dict)
    confidence: float = 0.0


# ═══════════════════════════════════════════
# Категории товаров и их вопросы
# ═══════════════════════════════════════════

CATEGORIES = {
    "одежда": {
        "question": ("Расскажи о товаре: что это, цвет, ткань, крой, воротник, "
                     "рукав, застёжка?"),
        "fields": ["type", "color", "material", "fit", "collar", "sleeve", "fastening"],
        "field_labels": {
            "type": "тип", "color": "цвет", "material": "ткань",
            "fit": "крой", "collar": "воротник", "sleeve": "рукав",
            "fastening": "застёжка",
        },
    },
    "модель_сцена": {
        "question": ("Опиши модель, одежду на ней, аксессуары. Где снимаем? "
                     "Фон, предметы в кадре?"),
        "fields": ["identity", "pose", "expression", "wardrobe", "accessories",
                    "location", "background", "props"],
        "field_labels": {
            "identity": "внешность (пол, возраст, волосы, глаза, кожа, телосложение)",
            "pose": "поза", "expression": "выражение лица", "wardrobe": "одежда",
            "accessories": "аксессуары", "location": "место съёмки",
            "background": "фон/окружение", "props": "предметы в кадре",
        },
    },
    "режиссура": {
        "question": ("Какое настроение у фото? Стиль съёмки "
                     "(естественный/студийный/лайфстайл)? "
                     "Освещение, ракурс, композиция, атмосфера?"),
        "fields": ["mood", "style", "lighting", "angle", "composition", "atmosphere"],
        "field_labels": {
            "mood": "настроение/эмоция", "style": "стиль съёмки",
            "lighting": "освещение", "angle": "ракурс",
            "composition": "композиция", "atmosphere": "атмосфера",
        },
    },
}

# Алиасы английских названий фаз
CATEGORY_ALIASES = {
    "product": "одежда",
    "model_scene": "модель_сцена",
    "direction": "режиссура",
    "одежда": "одежда",
    "модель_сцена": "модель_сцена",
    "режиссура": "режиссура",
}


class InterviewLayer:
    """Interview Layer — структура диалога с пользователем.

    Отвечает за:
      - Какие вопросы задавать
      - В каком порядке
      - Как уточнять

    Не отвечает за:
      - Парсинг ответов (это LLMTransformer)
      - Принятие решений (это DecisionMaker)
    """

    def __init__(self):
        self._state: Optional[InterviewState] = None

    # ─── CP-001 Contract ────────────────────────────────────

    def start(self, session_id: str, context: Optional[dict] = None) -> InterviewState:
        """Начать новое интервью (CP-001.8.1)."""
        self._state = InterviewState(
            session_id=session_id,
            current_phase=0,
        )
        return self._state

    def ask(self, state: Optional[InterviewState] = None,
            topic: str = "category") -> Question:
        """Сформулировать вопрос (CP-001.8.2).

        Args:
            state: текущее состояние интервью
            topic: тема вопроса (category, product, model_scene, direction...)

        Returns:
            Question — вопрос для пользователя
        """
        resolved = CATEGORY_ALIASES.get(topic, topic)

        if resolved in CATEGORIES:
            info = CATEGORIES[resolved]
            return Question(
                id=f"q_{topic}_{datetime.now().timestamp():.0f}",
                text=info["question"],
                type=QuestionType.PRODUCT,
                phase=self._state.current_phase if self._state else 0,
            )

        # Специальные вопросы
        special_questions = {
            "category": Question(
                id="q_category",
                text=("🏷️ **Какая категория товара?**\n\n"
                      "Выбери из списка:\n"
                      "• одежда\n• обувь\n• косметика\n• еда\n"
                      "• декор\n• электроника\n• уход\n• детское"),
                type=QuestionType.CATEGORY,
                phase=0,
                options=["одежда", "обувь", "косметика", "еда",
                         "декор", "электроника", "уход", "детское"],
            ),
            "reference": Question(
                id="q_reference",
                text="🖼 **Есть референс?** Опиши словами или скинь ссылку.\n"
                     "(Или напиши «нет», чтобы пропустить)",
                type=QuestionType.REFERENCE,
                phase=-2,
            ),
            "profile": Question(
                id="q_profile",
                text="🎭 **Выбери режиссёра/дизайнера/маркетолога**\n\n"
                     "Напиши имя, например: «Харари», «Нолан», «Айва»...\n"
                     "Или «Авто» — система подберёт сама",
                type=QuestionType.PROFILE,
                phase=-1,
            ),
            "model": Question(
                id="q_model",
                text="🎯 **Какая модель генерации?**\n"
                     "chatgpt / midjourney / nanobanana / flux / sdxl",
                type=QuestionType.MODEL_SELECT,
                phase=6,
                options=["chatgpt", "midjourney", "nanobanana", "flux", "sdxl"],
            ),
        }

        return special_questions.get(topic, Question(
            id=f"q_{topic}",
            text=f"Расскажи про {topic}?",
            type=QuestionType.CLARIFY,
            phase=self._state.current_phase if self._state else 0,
        ))

    def clarify(self, state: Optional[InterviewState] = None,
                unclear_fields: Optional[list[str]] = None) -> Question:
        """Сформулировать уточняющий вопрос (CP-001.8.4).

        Args:
            state: текущее состояние интервью
            unclear_fields: список неясных полей

        Returns:
            Question — уточняющий вопрос
        """
        if not unclear_fields:
            unclear_fields = []

        if len(unclear_fields) == 1:
            text = f"❓ **Уточни:** что с {unclear_fields[0]}?"
        else:
            fields_str = ", ".join(unclear_fields)
            text = f"❓ **Уточни:** {fields_str}?"

        return Question(
            id=f"q_clarify_{datetime.now().timestamp():.0f}",
            text=text,
            type=QuestionType.CLARIFY,
            phase=self._state.current_phase if self._state else 0,
        )

    def collect(self, state: Optional[InterviewState] = None) -> InterviewResult:
        """Собрать результаты интервью (заглушка — реальные данные из парсера).

        Returns: InterviewResult с текущим состоянием.
        """
        return InterviewResult(
            intents={},
            fields={},
            confidence=0.5,
        )

    def abort(self, session_id: Optional[str] = None) -> None:
        """Прервать интервью (CP-001.8.5)."""
        self._state = None

    # ─── Вспомогательные методы ─────────────────────────────

    def get_fields(self, topic: str) -> list[str]:
        """Получить список полей для темы."""
        resolved = CATEGORY_ALIASES.get(topic, topic)
        info = CATEGORIES.get(resolved)
        if info:
            return info["fields"]
        return []

    def get_field_labels(self, topic: str) -> dict:
        """Получить human-readable метки полей."""
        resolved = CATEGORY_ALIASES.get(topic, topic)
        info = CATEGORIES.get(resolved)
        if info:
            return info["field_labels"]
        return {}

    def supported_categories(self) -> list[str]:
        """Список поддерживаемых категорий товаров."""
        return list(CATEGORIES.keys())

    @property
    def state(self) -> Optional[InterviewState]:
        return self._state