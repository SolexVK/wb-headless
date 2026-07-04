"""VCOS — Tests: Prompt Exporter

Контракт extract_prompt_data ↔ build_full_story:
каждый ключ, который кладёт extract_prompt_data, читается build_full_story
(aspect_ratio читают модельные форматтеры). Плюс доменные переопределения
style_defaults / negative.
"""

import sys, os
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.renderers.prompt_exporter import (
    PromptExporter, build_full_story, extract_prompt_data,
)


# Ключи, которые ЧИТАЕТ build_full_story (канон)
BUILD_FULL_STORY_KEYS = {
    "intent", "profile", "category", "product",
    "character", "environment", "narrative", "focus", "timeline",
    "composition", "rule_of_thirds", "depth", "balance",
    "negative_space", "layers",
    "camera", "lighting", "color",
    "mood", "emotion", "atmosphere",
    "style", "constraints",
}

# Ключи, которые читают модельные форматтеры (_format_*)
FORMATTER_KEYS = {"aspect_ratio", "style_defaults", "negative"}


def _stub_project():
    """Минимальный стаб VisualProject для extract_prompt_data."""
    return NS(
        visual_design=NS(
            camera=NS(shot="medium shot", lens="85mm", angle="eye level",
                      dof="shallow", movement="", pov="", height=""),
            lighting=NS(key="golden backlight", fill="soft fill", rim="",
                        contrast="medium", temperature="warm",
                        shadow_quality="", volumetric=""),
            composition=NS(depth_layers="3 layers", negative_space="top",
                           leading_lines="", balance="asymmetric",
                           focus="product"),
            color=NS(palette="pastel", accent="mint", temperature="warm",
                     saturation="medium", harmony="analogous"),
            atmosphere=NS(mood="cozy", lighting_mood="warm glow",
                          particles="dust motes"),
            style=NS(medium="photography", rendering_style="photorealistic",
                     film_stock="", influences=[]),
        ),
        narrative=NS(
            characters=[NS(identity="девушка 25 лет", appearance="блондинка",
                           wardrobe="голубая рубашка", pose="стоя",
                           expression="улыбка")],
            world="солнечное кафе",
            focus="рубашка",
            timeline="утро",
        ),
        intent=NS(emotion="радость", message="рубашка оверсайз"),
        technical=NS(aspect_ratio="3:4"),
        constraints=NS(must_have=["белый фон"], must_not_have=["логотипы"]),
    )


def test_extract_prompt_data_keys_are_read_by_build_full_story():
    """Контракт: все ключи из extract_prompt_data читаются рендером."""
    data = extract_prompt_data(_stub_project())
    readable = BUILD_FULL_STORY_KEYS | FORMATTER_KEYS
    unread = set(data.keys()) - readable
    assert unread == set(), (
        f"extract_prompt_data кладёт ключи, которые никто не читает: {unread}"
    )


def test_extract_prompt_data_values_reach_prompt():
    """Данные не выпадают молча: environment/color/constraints в промпте."""
    data = extract_prompt_data(_stub_project())
    story = build_full_story(data)

    assert "солнечное кафе" in story        # environment (бывший 'world')
    assert "pastel" in story                # color (бывший 'colors')
    assert "рубашка оверсайз" in story      # product
    assert "рубашка" in story               # focus
    assert "утро" in story                  # timeline
    assert "белый фон" in story             # constraints.must_have
    assert "логотипы" in story              # constraints.must_not


def test_build_full_story_constraints_block():
    """Constraints рендерятся в явные строки Must have / Avoid."""
    story = build_full_story({
        "intent": "рубашка",
        "constraints": {"must_have": ["белый фон"], "must_not": ["текст"]},
    })
    assert "✅ Must have: белый фон" in story
    assert "🚫 Avoid: текст" in story


def test_exporter_default_style_backcompat():
    """Без style_defaults/negative дефолты прежние (обратная совместимость)."""
    e = PromptExporter()
    data = {"intent": "рубашка", "aspect_ratio": "1:1"}

    chatgpt = e.export(data, "chatgpt")
    assert "commercial product photography, not illustration, not 3D render" in chatgpt

    sdxl = e.export(data, "sdxl")
    assert "Negative prompt: dark, moody, sad, gloomy" in sdxl


def test_exporter_style_defaults_override():
    """style_defaults из data заменяет коммерческий стиль."""
    e = PromptExporter()
    data = {
        "intent": "нуар-сцена",
        "style_defaults": "cinematic film noir, dramatic shadows",
    }
    chatgpt = e.export(data, "chatgpt")
    assert "cinematic film noir, dramatic shadows" in chatgpt
    assert "commercial product photography" not in chatgpt

    nano = e.export(data, "nanobanana")
    assert "cinematic film noir" in nano
    assert "commercial product photography" not in nano

    flux = e.export(data, "flux")
    assert "cinematic film noir" in flux


def test_exporter_negative_override():
    """negative из data заменяет дефолтный negative prompt (не убивая нуар)."""
    e = PromptExporter()
    data = {
        "intent": "нуар-сцена",
        "negative": "low quality, blurry, watermark",
    }
    sdxl = e.export(data, "sdxl")
    assert "Negative prompt: low quality, blurry, watermark" in sdxl
    assert "dark, moody, sad, gloomy" not in sdxl
