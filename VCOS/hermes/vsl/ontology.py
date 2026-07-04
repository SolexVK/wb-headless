"""VCOS — VSL Ontology v1 (Visual Scene Language)

Формальное определение VSL как онтологии визуальной сцены.
Insight #2: VSL — язык, а не JSON. Агент «думает» на VSL.

Структура:
  Scene (корень)
   ├── Intent        — намерение, тип контента
   ├── Narrative     — сценарий, история (Insight #8)
   ├── Character     — персонаж, модель
   ├── Environment   — окружение, фон
   ├── Composition   — композиция кадра
   ├── Camera        — объектив, ракурс, ГРИП
   ├── Lighting      — световые схемы
   ├── Color         — палитра, температура
   ├── Style         — стиль, настроение, приёмы
   ├── Atmosphere    — атмосфера, частицы
   └── Motion        — движение, динамика
"""

from dataclasses import dataclass, field
from typing import Optional


# ═══════════════════════════════════════════
# VSL Block — единица онтологии
# ═══════════════════════════════════════════

@dataclass
class VSLField:
    """Одно поле VSL-блока."""
    name: str
    description: str
    examples: list[str] = field(default_factory=list)
    required: bool = False


@dataclass
class VSLBlock:
    """Один блок VSL-онтологии.

    Пример:
        block = VSLBlock(
            name="camera",
            description="Параметры камеры и съёмки",
            fields=[
                VSLField("lens", "Какой объектив", ["85mm", "50mm macro"]),
                VSLField("angle", "Ракурс съёмки", ["Уровень глаз", "Сверху"]),
            ]
        )
    """
    name: str
    description: str
    fields: list[VSLField] = field(default_factory=list)

    def __post_init__(self):
        self._field_index = {f.name: f for f in self.fields}

    def get_field(self, name: str) -> Optional[VSLField]:
        return self._field_index.get(name)

    @property
    def required_fields(self) -> list[VSLField]:
        return [f for f in self.fields if f.required]


# ═══════════════════════════════════════════
# VSL Ontology — полное описание языка
# ═══════════════════════════════════════════

class VSL:
    """Visual Scene Language — онтология визуальной сцены.

    Использование:
        vsl = VSL()
        block = vsl.get_block("camera")
        field = vsl.get_field("camera", "lens")
        all_blocks = vsl.list_blocks()
    """

    def __init__(self):
        self._blocks: dict[str, VSLBlock] = {}
        self._init_blocks()

    def _init_blocks(self):
        """Определить все VSL-блоки."""
        self._add(VSLBlock("intent", "Намерение и тип контента", [
            VSLField("purpose", "Цель съёмки", ["Реклама", "Каталог"]),
            VSLField("product_type", "Тип товара", ["Одежда", "Косметика"]),
            VSLField("emotion", "Эмоция/настроение", ["Уют", "Роскошь"]),
            VSLField("message", "Ключевое сообщение", ["Качество", "Стиль"]),
        ]))
        self._add(VSLBlock("creative_strategy", "Творческий замысел (156.txt)", [
            VSLField("core_idea", "Главная мысль", ["Статус рождается из сдержанности"]),
            VSLField("approach", "Подход к реализации", ["Минимализм через негативное пространство"]),
            VSLField("target_emotion", "Целевая эмоция", ["Уверенность", "Уют", "Восторг"]),
            VSLField("visual_metaphor", "Визуальная метафора", ["Остров в океане"]),
        ]))
        self._add(VSLBlock("narrative", "Сценарий и история (Insight #8)", [
            VSLField("story", "Краткий сюжет", ["Девушка пьёт кофе на террасе"]),
            VSLField("context", "Контекст действия", ["Утро, выходной день"]),
            VSLField("time_period", "Временной период", ["Наши дни", "60-е"]),
        ]))
        self._add(VSLBlock("character", "Модель и персонаж", [
            VSLField("identity", "Типаж", ["Девушка 25 лет", "Мужчина 40"]),
            VSLField("appearance", "Внешность", ["Блондинка", "Каре"]),
            VSLField("wardrobe", "Одежда/образ", ["Рубашка оверсайз"]),
            VSLField("expression", "Выражение лица", ["Лёгкая улыбка"]),
        ]))
        self._add(VSLBlock("environment", "Окружение и фон", [
            VSLField("location", "Локация", ["Улица", "Студия", "Кафе"]),
            VSLField("background", "Фон", ["Кирпичная стена", "Серый"]),
            VSLField("props", "Реквизит", ["Чашка кофе", "Сумка"]),
            VSLField("time_of_day", "Время суток", ["День", "Закат"]),
        ]))
        self._add(VSLBlock("composition", "Композиция кадра", [
            VSLField("shot", "План", ["Крупный", "Средний", "Общий"]),
            VSLField("rule_of_thirds", "Правило третей", ["Да", "Нет"]),
            VSLField("balance", "Баланс", ["Симметрично", "Асимметрично"]),
            VSLField("depth_layers", "Слои глубины", ["3 слоя"]),
            VSLField("negative_space", "Негативное пространство", ["Сверху"]),
            VSLField("leading_lines", "Направляющие линии", ["Линии стола"]),
        ]))
        self._add(VSLBlock("camera", "Камера и объектив", [
            VSLField("lens", "Объектив", ["85mm", "50mm", "35mm"]),
            VSLField("pov", "Точка съёмки", ["От 1-го лица", "Наблюдатель"]),
            VSLField("angle", "Ракурс", ["Уровень глаз", "Сверху", "Снизу"]),
            VSLField("height", "Высота камеры", ["Поясной", "Ростовой"]),
            VSLField("dof", "Глубина резкости", ["Малая", "Средняя"]),
        ]))
        self._add(VSLBlock("lighting", "Освещение", [
            VSLField("key", "Ключевой свет", ["Боковой 45°", "Контражур"]),
            VSLField("fill", "Заполняющий", ["Мягкий рефлектор"]),
            VSLField("rim", "Контровой", ["Да, для отделения"]),
            VSLField("contrast", "Контраст", ["Высокий", "Низкий"]),
            VSLField("temperature", "Цветовая температура", ["Тёплый 3000K"]),
            VSLField("shadow_quality", "Качество теней", ["Мягкие", "Жёсткие"]),
        ]))
        self._add(VSLBlock("color", "Цвет", [
            VSLField("palette", "Палитра", ["Пастельная", "Монохромная"]),
            VSLField("accent", "Акцент", ["Красный", "Золотой"]),
            VSLField("saturation", "Насыщенность", ["Высокая", "Приглушённая"]),
            VSLField("harmony", "Гармония", ["Комплементарная"]),
        ]))
        self._add(VSLBlock("style", "Стиль и настроение", [
            VSLField("mood", "Настроение", ["Тёплое", "Загадочное"]),
            VSLField("rendering_style", "Стиль рендера", ["Фотореализм"]),
            VSLField("film_stock", "Отсылка к плёнке", ["Кодак Портре"]),
            VSLField("art_direction", "Арт-дирекция", ["Натуральный"]),
            VSLField("reference", "Референс", ["Ссылка или стиль"]),
        ]))
        self._add(VSLBlock("atmosphere", "Атмосфера", [
            VSLField("density", "Плотность", ["Лёгкая дымка"]),
            VSLField("particles", "Частицы", ["Пыль в воздухе"]),
        ]))
        self._add(VSLBlock("motion", "Движение", [
            VSLField("blur", "Размытие", ["Motion blur"]),
            VSLField("dynamic", "Динамика", ["Стоп-кадр"]),
        ]))

    def _add(self, block: VSLBlock):
        self._blocks[block.name] = block

    # ═══════════════════════════════════════════
    # API
    # ═══════════════════════════════════════════

    def get_block(self, name: str) -> Optional[VSLBlock]:
        """Получить блок по имени."""
        return self._blocks.get(name)

    def get_field(self, block_name: str, field_name: str) -> Optional[VSLField]:
        """Получить поле внутри блока."""
        block = self._blocks.get(block_name)
        if block:
            return block.get_field(field_name)
        return None

    def list_blocks(self) -> list[str]:
        """Список имён всех блоков."""
        return list(self._blocks.keys())

    def list_fields(self, block_name: str) -> list[str]:
        """Список полей блока."""
        block = self._blocks.get(block_name)
        if block:
            return [f.name for f in block.fields]
        return []

    def required_blocks(self) -> list[str]:
        """Блоки, в которых есть обязательные поля."""
        return [name for name, b in self._blocks.items()
                if any(f.required for f in b.fields)]

    def to_dict(self) -> dict:
        """Полное описание онтологии."""
        return {
            name: {
                "description": block.description,
                "fields": [f.name for f in block.fields],
            }
            for name, block in self._blocks.items()
        }


# ═══════════════════════════════════════════
# Singleton
# ═══════════════════════════════════════════

_VSL_INSTANCE: Optional[VSL] = None


def get_vsl() -> VSL:
    """Глобальный экземпляр VSL (singleton)."""
    global _VSL_INSTANCE
    if _VSL_INSTANCE is None:
        _VSL_INSTANCE = VSL()
    return _VSL_INSTANCE