# CO-001 Examples

## Example 1: Full Project Lifecycle

```python
# 1. User expresses intent
intent = Intent(
    description="Сделать продающий баннер для премиального кофе",
    source="chat",
    confidence=0.2
)

# 2. Goals are derived
goal_1 = Goal(
    description="Продать ощущение уюта и премиальности",
    parent_intent_id=intent.id,
    priority=1,
    rationale="Премиальный кофе продаётся через атмосферу, не через цену"
)

goal_2 = Goal(
    description="Вызвать желание выпить чашку прямо сейчас",
    parent_intent_id=intent.id,
    priority=2
)

# 3. Facts are gathered
fact_1 = Fact(
    description="Утренний свет — мягкий, тёплый, золотистый",
    source="knowledge:film",
    certainty="CONFIRMED"
)

fact_2 = Fact(
    description="Текстура пара ассоциируется со свежестью",
    source="knowledge:advertising",
    certainty="ASSUMED"
)

# 4. Decisions are made
decision_1 = Decision(
    value="Крупный план чашки с паром, малая глубина резкости",
    rationale="Крупный план создаёт интимность, пар = свежесть",
    confidence=0.85,
    alternatives=[
        {"value": "Общий план кофейни", "rationale": "Показывает атмосферу целиком"}
    ],
    source="reasoning"
)

# 5. Blueprint compiles approved decisions
blueprint = Blueprint(
    content={
        "scene_type": "macro_product",
        "subject": "coffee_cup",
        "lighting": "warm_morning",
        "composition": "close_up",
        "depth_of_field": "shallow",
        "color_palette": "golden_brown"
    },
    source_decisions=[decision_1.id]
)

# 6. Renderer produces artifact
artifact = Artifact(
    type="prompt",
    content="Крупный план керамической чашки с кофе, пар поднимается...",
    renderer="human_readable",
    source_blueprint_id=blueprint.id
)
```

## Example 2: Gap Detection

```python
# Intent exists, but no goals
graph.state = {
    "intent": Intent(description="Баннер для Telegram"),
    "goals": [],
    "facts": [],
    "decisions": []
}
# Gap Analyzer output:
# "No goals defined. Ask: какие 2-3 цели?"
```

## Example 3: Decision Tree

```python
# A decision tree for "how to show anxiety"
decision_1 = Decision(value="Tilted camera angle", confidence=0.6)
  → parent of
    → decision_1a = Decision(value="15-degree tilt", confidence=0.7)
    → decision_1b = Decision(value="Dutch angle", confidence=0.5)
decision_2 = Decision(value="Desaturated colors", confidence=0.8)
  → parent of
    → decision_2a = Decision(value="Green tint", confidence=0.6)

# Only APPROVED decisions go into Blueprint
# decision_1b (Dutch angle, 0.5) is rejected → not included
```