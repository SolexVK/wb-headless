"""VCOS — Photography Knowledge Provider v1

Правила и стандарты предметной фотосъёмки.
Rule-based провайдер (CP-001.5).

Покрывает:
  - Камера: объективы, ракурсы, ГРИП
  - Свет: схемы освещения для разных типов товаров
  - Композиция: стандарты для WB, каталогов, рекламы
  - Цвет: палитры для разных категорий
"""

from hermes.knowledge.provider import (
    KnowledgeProvider, KnowledgeRequest, KnowledgeResult, KnowledgeFact
)


class PhotographyProvider(KnowledgeProvider):
    """Правила предметной фотосъёмки.

    Используется когда:
      - Нужен объектив для конкретного типа съёмки
      - Нужна схема света для товара
      - Нужны стандарты для WB / каталога
    """

    name = "photography-rules"
    domain = ["photography", "product-photography"]
    version = "1.0.0"

    # Правила: (domain, context_key, context_value, block, field, value, confidence)
    _rules = [
        # ─── Объективы по типу съёмки ────────────────────────
        ("product-photography", "product_type", "одежда",
         "camera", "lens", "85-105mm для одежды в полный рост, 50mm для деталей", 0.85),
        ("product-photography", "product_type", "обувь",
         "camera", "lens", "50-85mm, акцент на текстуру кожи и форму", 0.85),
        ("product-photography", "product_type", "косметика",
         "camera", "lens", "100mm macro для текстур, 85mm для флаконов", 0.9),
        ("product-photography", "product_type", "еда",
         "camera", "lens", "50mm для flat lay, 85mm для деталей, 100mm macro", 0.85),
        ("product-photography", "product_type", "декор",
         "camera", "lens", "35-50mm для контекста, 85mm для деталей", 0.8),
        ("product-photography", "product_type", "электроника",
         "camera", "lens", "50mm, чистая геометрия, без искажений", 0.85),

        # ─── Ракурсы ─────────────────────────────────────────
        ("product-photography", "product_type", "одежда",
         "camera", "angle", "Передний прямой — для каталога. 3/4 — для лайфстайл", 0.8),
        ("product-photography", "product_type", "обувь",
         "camera", "angle", "45 градусов — классика. Сверху — для flat lay", 0.8),

        # ─── Схемы света ─────────────────────────────────────
        ("product-photography", "product_type", "одежда",
         "lighting", "key", "Мягкий боковой (45°) + заполняющий с другой стороны", 0.85),
        ("product-photography", "product_type", "косметика",
         "lighting", "key", "Контражур + мягкий передний. Флакон должен светиться", 0.85),
        ("product-photography", "product_type", "еда",
         "lighting", "key", "Боковой + контражур. Тёплый, естественный", 0.85),
        ("product-photography", "product_type", "электроника",
         "lighting", "key", "Чистый студийный. Чёткие тени для объёма", 0.8),
        ("product-photography", "product_type", "декор",
         "lighting", "key", "Мягкий рассеянный. Акцент на текстуру", 0.8),

        # ─── Композиция ──────────────────────────────────────
        ("product-photography", "product_type", "одежда",
         "composition", "rule_of_thirds",
         "Объект в правой/левой трети, много негативного пространства сверху", 0.8),
        ("product-photography", "product_type", "косметика",
         "composition", "balance",
         "Симметричная — для люкса. Асимметричная — для масс-маркета", 0.8),
        ("product-photography", "product_type", "еда",
         "composition", "depth_layers",
         "3 слоя: передний (тарелка), средний (стакан), задний (декор)", 0.8),

        # ─── Цветовые схемы ──────────────────────────────────
        ("product-photography", "product_type", "одежда",
         "color", "temperature",
         "Натуральная (neutral-warm). Белый фон для карточек WB", 0.8),
        ("product-photography", "product_type", "косметика",
         "color", "temperature",
         "Холодная для «клиникл», тёплая для «натурал»", 0.8),
        ("product-photography", "product_type", "еда",
         "color", "temperature",
         "Тёплая, аппетитная. Золотистый + коричневый", 0.85),

        # ─── Стандарты WB ────────────────────────────────────
        ("product-photography", "platform", "wb",
         "technical", "aspect_ratio",
         "1:1 для карточки товара, 3:4 для галереи", 0.9),
        ("product-photography", "platform", "wb",
         "style", "rendering_style",
         "Фотореалистичный, без художественных искажений", 0.9),
        ("product-photography", "platform", "wb",
         "composition", "focus",
         "Товар в фокусе, фон нейтральный, без отвлекающих деталей", 0.9),
    ]

    def query(self, request: KnowledgeRequest) -> KnowledgeResult:
        """Найти факты по запросу.

        Контекст может содержать:
          - product_type: тип товара
          - platform: платформа (wb, ozon, ym)
          - style: желаемый стиль
        """
        facts = []
        product_type = request.context.get("product_type", "").lower()
        platform = request.context.get("platform", "").lower()

        for rule in self._rules:
            rule_domain, key, value, block, field, rule_value, confidence = rule

            # Проверить домен (точное сравнение, rule_domain может быть списком)
            rule_domains = (rule_domain if isinstance(rule_domain, (list, tuple))
                            else [rule_domain])
            if request.domain and request.domain not in rule_domains:
                continue

            # Проверить контекст
            if key == "product_type" and product_type and product_type != value:
                continue
            if key == "platform" and platform and platform != value:
                continue

            facts.append(KnowledgeFact(
                domain=rule_domain,
                block=block,
                vsl_field=field,
                value=rule_value,
                confidence=confidence,
                source=f"{self.name}/{key}={value}",
                tags=[block, field, value],
            ))

        # Сортировать по уверенности
        facts.sort(key=lambda f: f.confidence, reverse=True)

        return KnowledgeResult(
            facts=facts[:request.max_results],
            confidence=sum(f.confidence for f in facts[:3]) / min(len(facts[:3]), 3) if facts else 0.5,
            source=self.name,
        )


class LightingKnowledgeProvider(KnowledgeProvider):
    """Правила освещения для разных типов продуктов и настроений."""

    name = "lighting-rules"
    domain = ["photography", "lighting"]
    version = "1.0.0"

    _mood_lighting = {
        "уют": ("Мягкий золотистый свет, 2700-3000K, заполняющий с рефлектором", 0.9),
        "роскошь": ("Контражур + боковой. Тёплый металлик. Драматические тени", 0.85),
        "минимализм": ("Чистый студийный. Высокий ключ. Мягкие тени", 0.85),
        "натуральный": ("Естественный дневной. Рассеянный через окно", 0.8),
        "драма": ("Жёсткий боковой, глубокие тени. Низкий ключ", 0.85),
        "романтика": ("Мягкий рассеянный, розоватый оттенок, лёгкий глоу", 0.8),
    }

    def query(self, request: KnowledgeRequest) -> KnowledgeResult:
        facts = []
        mood = request.context.get("mood", "").lower()
        product_type = request.context.get("product_type", "").lower()

        # Подбор по настроению (пустой mood не должен матчиться ни с чем)
        for mood_name, (value, conf) in self._mood_lighting.items():
            if mood and (mood_name in mood or mood in mood_name):
                facts.append(KnowledgeFact(
                    domain="lighting",
                    block="lighting", vsl_field="key",
                    value=value, confidence=conf,
                    source=f"lighting-rules/mood={mood_name}",
                    tags=["mood", mood_name],
                ))
                break

        # Стандартные схемы по типу товара
        if product_type == "косметика":
            facts.append(KnowledgeFact(
                domain="lighting", block="lighting", vsl_field="contrast",
                value="Средний, с акцентом на текстуру и отражения. Флакон = объект", confidence=0.85,
                source="lighting-rules/product=cosmetics",
            ))
        elif product_type == "еда":
            facts.append(KnowledgeFact(
                domain="lighting", block="lighting", vsl_field="temperature",
                value="Тёплый, золотистый. Избегать холодного — еда выглядит неаппетитно",
                confidence=0.9,
                source="lighting-rules/product=food",
            ))

        return KnowledgeResult(
            facts=facts[:request.max_results],
            confidence=0.8 if facts else 0.3,
            source=self.name,
        )