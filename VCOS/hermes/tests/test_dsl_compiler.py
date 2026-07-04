"""VCOS — Tests: DSL Compiler (Phase 3D)

Проверяет компиляцию graph data → SemDSL → Prompt.
Не требует LLM.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.renderers.dsl_compiler import (
    DSLCompiler, SemDSL, SemDSLIntent, SemDSLCharacter,
    compile_to_dsl, compile_to_prompt,
    _parse_fields, _dsl_to_story,
)


# ═══════════════════════════════════════════
# Parse Fields
# ═══════════════════════════════════════════

def test_parse_fields_simple():
    """Разбор простых field: value пар."""
    result = _parse_fields("type: рубашка; color: синяя")
    assert result["type"] == "рубашка"
    assert result["color"] == "синяя"


def test_parse_fields_bare_text():
    """Разбор текста без field: — ключ 'text'."""
    result = _parse_fields("просто текст")
    assert result.get("text") == "просто текст"


def test_parse_fields_empty():
    """Пустой текст — пустой dict с ключом 'text'."""
    result = _parse_fields("")
    assert len(result) == 1
    assert "text" in result


def test_parse_fields_mixed():
    """Смешанный текст с field: и без — bare text идёт в 'text'."""
    result = _parse_fields("type: рубашка; синяя; material: хлопок")
    assert result["type"] == "рубашка"
    assert result["material"] == "хлопок"
    assert "text" in result  # "синяя" — bare text
    assert result["text"] == "синяя"


# ═══════════════════════════════════════════
# Compile to DSL
# ═══════════════════════════════════════════

def test_compile_empty_data():
    """Пустые данные → пустой DSL."""
    dsl = compile_to_dsl({})
    assert dsl.is_empty


def test_compile_intent():
    """Компиляция intent с полями."""
    dsl = compile_to_dsl({
        "intent": "type: рубашка; color: синяя; material: хлопок",
        "category": "одежда",
    })
    assert dsl.intent.product_type == "рубашка"
    assert dsl.intent.color == "синяя"
    assert dsl.intent.material == "хлопок"
    assert "одежда" in dsl.domain


def test_compile_character():
    """Компиляция character."""
    dsl = compile_to_dsl({
        "character": "identity: девушка 25 лет; wardrobe: рубашка джинсы; "
                      "expression: улыбка",
    })
    assert dsl.character.identity == "девушка 25 лет"
    assert "рубашка" in dsl.character.wardrobe
    assert dsl.character.expression == "улыбка"


def test_compile_camera():
    """Компиляция camera."""
    dsl = compile_to_dsl({
        "camera": "lens: 85mm; shot: средний план; angle: уровень глаз",
    })
    assert dsl.camera.lens == "85mm"
    assert dsl.camera.shot == "средний план"
    assert "глаз" in dsl.camera.angle


def test_compile_lighting():
    """Компиляция lighting."""
    dsl = compile_to_dsl({
        "lighting": "key: золотой контражур; contrast: средний; "
                     "temperature: тёплый",
    })
    assert "золотой" in dsl.lighting.key_light
    assert dsl.lighting.contrast == "средний"
    assert dsl.lighting.temperature == "тёплый"


def test_compile_color():
    """Компиляция color."""
    dsl = compile_to_dsl({
        "color": "palette: пастельная; accent: мятный; harmony: analogous",
    })
    assert dsl.color.palette == "пастельная"
    assert dsl.color.accent == "мятный"
    assert dsl.color.harmony == "analogous"


def test_compile_style():
    """Компиляция style."""
    dsl = compile_to_dsl({
        "style": "medium: photography; rendering_style: photorealistic; "
                  "film_stock: Kodak",
    })
    assert dsl.style.medium == "photography"
    assert dsl.style.rendering_style == "photorealistic"
    assert dsl.style.film_stock == "Kodak"


def test_compile_mood():
    """Компиляция mood."""
    dsl = compile_to_dsl({"mood": "mood: тёплое"})
    assert dsl.mood.mood == "тёплое"


def test_compile_profile():
    """Компиляция profile."""
    dsl = compile_to_dsl({"profile": "Харари"})
    assert dsl.profile.name == "Харари"


def test_compile_full_scene():
    """Полная компиляция сцены со всеми блоками."""
    dsl = compile_to_dsl({
        "intent": "type: рубашка; color: голубая; material: хлопок",
        "character": "identity: девушка; wardrobe: рубашка; expression: улыбка",
        "environment": "location: кафе; time_of_day: солнечный день",
        "composition": "framing: classic; rule_of_thirds: respect; depth: moderate",
        "camera": "lens: 85mm; shot: средний план",
        "lighting": "key: золотой контражур; temperature: тёплый",
        "color": "palette: пастельная; accent: мятный",
        "mood": "mood: тёплое",
        "style": "medium: photography; rendering_style: photorealistic",
        "profile": "Харари",
        "aspect_ratio": "3:4",
        "category": "одежда",
    })
    assert not dsl.is_empty
    assert dsl.intent.product_type == "рубашка"
    assert dsl.character.identity == "девушка"
    assert dsl.environment.location == "кафе"
    assert dsl.composition.framing == "classic"
    assert dsl.camera.lens == "85mm"
    assert dsl.lighting.key_light == "золотой контражур"
    assert dsl.color.palette == "пастельная"
    assert dsl.mood.mood == "тёплое"
    assert dsl.style.medium == "photography"
    assert dsl.profile.name == "Харари"
    assert dsl.aspect_ratio == "3:4"


# ═══════════════════════════════════════════
# DSL → Story
# ═══════════════════════════════════════════

def test_dsl_to_story_empty():
    """Пустой DSL → пустая строка."""
    story = _dsl_to_story(SemDSL())
    assert story == ""


def test_dsl_to_story_concept():
    """DSL с intent → строка с Concept."""
    dsl = SemDSL(intent=SemDSLIntent(product_type="рубашка", color="синяя"))
    story = _dsl_to_story(dsl)
    assert "🎬 Concept" in story
    assert "рубашка" in story
    assert "синяя" in story


def test_dsl_to_story_character():
    """DSL с character → строка с Character."""
    dsl = SemDSL(character=SemDSLCharacter(
        identity="девушка", wardrobe="рубашка", expression="улыбка"
    ))
    story = _dsl_to_story(dsl)
    assert "👤 Character" in story
    assert "девушка" in story
    assert "рубашка" in story


# ═══════════════════════════════════════════
# Full Pipeline: Compile → Render
# ═══════════════════════════════════════════

def test_full_pipeline_chatgpt():
    """Полный пайплайн: data → DSL → ChatGPT prompt."""
    compiler = DSLCompiler()
    prompt = compiler.full_compile({
        "intent": "type: рубашка; color: синяя",
        "character": "identity: девушка",
        "profile": "Харари",
        "aspect_ratio": "",
    }, "chatgpt")

    assert "🎬 Concept" in prompt
    assert "рубашка" in prompt
    assert "👤 Character" in prompt
    assert "TSECHNICAL SPECIFICATION" in prompt or "TECHNICAL" in prompt


def test_full_pipeline_midjourney():
    """Полный пайплайн: data → DSL → Midjourney prompt."""
    compiler = DSLCompiler()
    prompt = compiler.full_compile({
        "intent": "type: рубашка; color: синяя",
        "character": "identity: девушка",
        "aspect_ratio": "1:1",
    }, "midjourney")

    assert "🎬 Concept" in prompt
    assert "--ar 1:1" in prompt
    assert "--v 6" in prompt


def test_full_pipeline_sdxl():
    """Полный пайплайн: data → DSL → SDXL prompt."""
    compiler = DSLCompiler()
    prompt = compiler.full_compile({
        "intent": "type: рубашка; color: синяя",
    }, "sdxl")

    assert "🎬 Concept" in prompt
    assert "Negative prompt" in prompt
    assert "CFG: 4.0" in prompt


def test_full_pipeline_flux():
    """Полный пайплайн: data → DSL → Flux prompt."""
    compiler = DSLCompiler()
    prompt = compiler.full_compile({
        "intent": "type: рубашка; color: синяя",
    }, "flux")

    assert "🎬 Concept" in prompt
    assert "Photorealistic" in prompt


def test_full_pipeline_roundtrip():
    """Roundtrip: compile → render не падает на любых данных."""
    compiler = DSLCompiler()
    # Пустые данные — пустой результат
    result1 = compiler.full_compile({}, "chatgpt")
    assert isinstance(result1, str)

    # Пустой intent — промпт только с техспеками
    result2 = compiler.full_compile({"intent": ""}, "midjourney")
    assert isinstance(result2, str)

    # None — пустая строка
    assert compiler.full_compile(None, "chatgpt") == ""


# ═══════════════════════════════════════════
# Доменные переопределения style_defaults / negative
# ═══════════════════════════════════════════

def test_style_defaults_default_backcompat():
    """Без style_defaults — прежний коммерческий дефолт."""
    compiler = DSLCompiler()
    prompt = compiler.full_compile({"intent": "type: рубашка"}, "chatgpt")
    assert "commercial product photography, not illustration, not 3D render" in prompt


def test_style_defaults_override():
    """style_defaults из data заменяет коммерческий стиль."""
    compiler = DSLCompiler()
    data = {
        "intent": "type: нуар-сцена",
        "style_defaults": "cinematic film noir, high contrast",
    }
    for model in ("chatgpt", "nanobanana", "flux"):
        prompt = compiler.full_compile(data, model)
        assert "cinematic film noir" in prompt, model
        assert "commercial product photography" not in prompt, model


def test_negative_default_backcompat():
    """Без negative — прежний дефолтный negative prompt."""
    compiler = DSLCompiler()
    prompt = compiler.full_compile({"intent": "type: рубашка"}, "sdxl")
    assert "Negative prompt: dark, moody, sad, gloomy" in prompt


def test_negative_override():
    """negative из data не убивает нуар/кино-домены."""
    compiler = DSLCompiler()
    prompt = compiler.full_compile({
        "intent": "type: нуар-сцена",
        "negative": "low quality, blurry, watermark",
    }, "sdxl")
    assert "Negative prompt: low quality, blurry, watermark" in prompt
    assert "dark, moody, sad, gloomy" not in prompt


# ═══════════════════════════════════════════
# DSL Compiler class
# ═══════════════════════════════════════════

def test_compiler_class():
    """DSLCompiler с раздельными этапами."""
    compiler = DSLCompiler()
    dsl = compiler.compile({"intent": "type: рубашка", "profile": "Харари"})
    assert dsl.intent.product_type == "рубашка"
    assert dsl.profile.name == "Харари"

    prompt = compiler.render(dsl, "chatgpt")
    assert "🎬 Concept" in prompt
    assert "рубашка" in prompt