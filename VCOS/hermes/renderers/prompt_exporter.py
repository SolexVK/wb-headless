"""VCOS — Prompt Exporter v2

Мультимодельный экспорт промпта.
ФАЙЛ СОХРАНЯЕТ ВСЮ ДЕТАЛИЗАЦИЮ VSL.
Меняется только синтаксис (параметры, обёртки), а не содержание.

Принцип:
  «Сначала содержание. Формат — только обёртка.»
"""

from dataclasses import dataclass, field
from typing import Optional


# ═══════════════════════════════════════════
# Референс
# ═══════════════════════════════════════════

@dataclass
class ReferenceSlot:
    """Описание референсного изображения."""
    enabled: bool = False
    description: str = ""                # Единое описание референса
    style_description: str = ""          # "как в каталоге & Other Stories"
    color_reference: str = ""            # "цветовая гамма как ..."
    composition_reference: str = ""      # "композиция как ..."
    lighting_reference: str = ""         # "свет как ..."
    mood_reference: str = ""             # "настроение как ..."
    key_elements: str = ""               # "обязательно показать ..."

    def summary(self) -> str:
        """Краткая сводка."""
        if not self.enabled:
            return ""
        parts = [p for p in [self.description, self.style_description] if p]
        return parts[0] if parts else ""


# ═══════════════════════════════════════════
# Развёрнутый промпт (полная VSL-детализация)
# ═══════════════════════════════════════════

def build_full_story(data: dict, ref: Optional[ReferenceSlot] = None) -> str:
    """Построить красивое структурированное описание сцены.

    Формат как в ScenePromptRenderer v2:
      🎬 Концепция — 🎥 Съёмка — 💡 Освещение — 🎨 Цвета — ...
    """
    paragraphs = []

    # Референс
    if ref and ref.enabled:
        ref_text = ref.summary()
        if ref_text:
            paragraphs.append(f"🖼 Reference style: {ref_text}")

    # 1. INTENT — товар и концепция
    intent = data.get("intent", "")
    profile = data.get("profile", "")
    category = data.get("category", "")
    if intent:
        paragraphs.append(f"🎬 Concept: {intent}")
    elif category:
        paragraphs.append(f"🎬 Product photo: {category}")

    # 1b. PRODUCT — сообщение/товар (если отличается от концепции)
    product = data.get("product", "")
    if product and product != intent:
        paragraphs.append(f"📦 Product: {product}")

    # 2. CHARACTER — персонаж
    character = data.get("character", "")
    if character:
        paragraphs.append(f"👤 Character: {character}")

    # 3. ENVIRONMENT — окружение
    env = data.get("environment", "")
    if env:
        paragraphs.append(f"🌍 Setting: {env}")

    # 4. NARRATIVE — сцена и детали
    narrative = data.get("narrative", "")
    if narrative and narrative != env:
        paragraphs.append(f"📖 Scene: {narrative}")

    # 4b. FOCUS — визуальный фокус сцены
    focus = data.get("focus", "")
    if focus:
        paragraphs.append(f"🎯 Focus: {focus}")

    # 4c. TIMELINE — временная линия повествования
    timeline = data.get("timeline", "")
    if timeline:
        paragraphs.append(f"⏳ Timeline: {timeline}")

    # 5. COMPOSITION — композиция кадра
    comp = data.get("composition", "")
    if comp:
        paragraphs.append(f"📐 Composition: {comp}")
    else:
        # Собрать из отдельных полей
        comp_parts = []
        for f in ["rule_of_thirds", "depth", "balance", "negative_space", "layers"]:
            v = data.get(f, "")
            if v:
                comp_parts.append(f"{v}")
        if comp_parts:
            paragraphs.append(f"📐 Composition: {', '.join(comp_parts)}")

    # 6. CAMERA — камера и съёмка
    camera = data.get("camera", "")
    if camera:
        paragraphs.append(f"🎥 Camera: {camera}")

    # 7. LIGHTING — освещение
    lighting = data.get("lighting", "")
    if lighting:
        paragraphs.append(f"💡 Lighting: {lighting}")

    # 8. COLOR — цвета
    color_val = data.get("color", "")
    if color_val:
        paragraphs.append(f"🎨 Colors: {color_val}")

    # 9. MOOD — настроение
    mood = data.get("mood", "")
    if mood:
        paragraphs.append(f"💭 Mood: {mood}")
    emotion = data.get("emotion", "")
    if emotion and emotion != mood:
        paragraphs.append(f"😊 Emotion: {emotion}")
    atmosphere = data.get("atmosphere", "")
    if atmosphere and atmosphere != mood:
        paragraphs.append(f"🌫 Atmosphere: {atmosphere}")

    # 10. STYLE — стиль (профиль + направление)
    style = data.get("style", "")
    if style:
        paragraphs.append(f"🎬 Style: {style}")

    # 11. CONSTRAINTS — ограничения проекта попадают в промпт
    constraints = data.get("constraints", {})
    if isinstance(constraints, dict):
        must_have = [c for c in constraints.get("must_have", []) if c]
        must_not = [c for c in constraints.get("must_not", []) if c]
        if must_have:
            paragraphs.append(f"✅ Must have: {'; '.join(must_have)}")
        if must_not:
            paragraphs.append(f"🚫 Avoid: {'; '.join(must_not)}")
    elif constraints:
        paragraphs.append(f"🚫 Constraints: {constraints}")

    # 12. Профиль как подпись (если есть)
    if profile and "profile" not in style.lower():
        paragraphs.append(f"🎭 Profile applied: {profile}")

    return "\n\n".join(p for p in paragraphs if p)


# ═══════════════════════════════════════════
# Модели
# ═══════════════════════════════════════════

SUPPORTED_MODELS = {
    "chatgpt": "ChatGPT / DALL-E 3",
    "midjourney": "Midjourney v6",
    "nanobanana": "Nano Banana Pro",
    "flux": "Flux Pro",
    "sdxl": "Stable Diffusion XL",
}


class PromptExporter:
    """Экспорт промпта под конкретную модель.
    
    Меняется ТОЛЬКО:
      - синтаксис параметров (--ar, --v и т.д.)
      - техническая обёртка (negative prompt, steps)
      - разделители (абзацы / запятые / точки)
    
    СОДЕРЖАНИЕ сохраняется полностью.
    """

    def __init__(self):
        self.last_prompt = ""

    def export(self, prompt_data: dict, target_model: str,
               reference: Optional[ReferenceSlot] = None) -> str:
        """Сгенерировать промпт для указанной модели.

        Args:
            prompt_data: словарь с полями (world, character, product...)
            target_model: 'chatgpt', 'midjourney', ...
            reference: опциональный референс
        """
        exporters = {
            "chatgpt": self._format_chatgpt,
            "midjourney": self._format_midjourney,
            "nanobanana": self._format_nanobanana,
            "flux": self._format_flux,
            "sdxl": self._format_sdxl,
        }
        formatter = exporters.get(target_model, self._format_chatgpt)
        prompt = formatter(prompt_data, reference)
        self.last_prompt = prompt
        return prompt

    # ─── ChatGPT / DALL-E 3 ────────────────────────────────

    def _format_chatgpt(self, data: dict, ref: Optional[ReferenceSlot]) -> str:
        """DALL-E 3: естественный язык, полные абзацы + техспеки."""
        story = build_full_story(data, ref)

        aspect = data.get("aspect_ratio", "3:4")
        style_line = data.get("style_defaults") or (
            "commercial product photography, not illustration, not 3D render"
        )

        tech = (
            f"\n\n--- TECHNICAL SPECIFICATION ---\n"
            f"Aspect ratio: {aspect}\n"
            f"Quality: photorealistic, ultra-detailed, 4K resolution\n"
            f"Style: {style_line}\n"
            f"Output: realistic photographic image, high detail, natural skin texture"
        )

        return story + tech

    # ─── Midjourney v6 ─────────────────────────────────────

    def _format_midjourney(self, data: dict, ref: Optional[ReferenceSlot]) -> str:
        """Midjourney v6: полное содержание, запятые, парамтры в конце.

        Midjourney отлично понимает длинные описания.
        Главное — разделять запятыми и добавлять параметры.
        """
        story = build_full_story(data, ref)

        # Заменяем абзацы на разделение запятыми + переходы строк
        # Midjourney лучше работает с логическими блоками
        lines = story.split("\n\n")
        # Склеиваем запятыми, каждый блок с новой строки
        mj_body = "\n".join(line.strip() for line in lines if line.strip())

        aspect = data.get("aspect_ratio", "3:4")
        ar_map = {
            "3:4": "--ar 3:4", "9:16": "--ar 9:16", "1:1": "--ar 1:1",
            "16:9": "--ar 16:9", "4:5": "--ar 4:5",
        }
        ar_param = ar_map.get(aspect, f"--ar {aspect}")

        return f"{mj_body}\n\n{ar_param} --v 6 --style raw --s 250"

    # ─── Nano Banana Pro ───────────────────────────────────

    def _format_nanobanana(self, data: dict, ref: Optional[ReferenceSlot]) -> str:
        """Nano Banana Pro: полное содержание, техспеки отдельно."""
        story = build_full_story(data, ref)

        aspect = data.get("aspect_ratio", "3:4")
        style_line = data.get("style_defaults") or "commercial product photography"

        tech = (
            f"\n\n--- Technical ---\n"
            f"Aspect ratio: {aspect}\n"
            f"Quality: photorealistic, 4K\n"
            f"Style: {style_line}"
        )

        return story + tech

    # ─── Flux Pro ──────────────────────────────────────────

    def _format_flux(self, data: dict, ref: Optional[ReferenceSlot]) -> str:
        """Flux Pro: полное содержание, точки между блоками."""
        story = build_full_story(data, ref)

        aspect = data.get("aspect_ratio", "3:4")
        style_line = data.get("style_defaults") or (
            "Photorealistic, high detail, commercial photography"
        )

        return (
            f"{story}\n\n"
            f"Aspect ratio: {aspect}. "
            f"{style_line}."
        )

    # ─── Stable Diffusion XL ───────────────────────────────

    def _format_sdxl(self, data: dict, ref: Optional[ReferenceSlot]) -> str:
        """SDXL: веса для ключевых элементов + negative prompt."""
        story = build_full_story(data, ref)

        # Добавляем веса: товар и персонаж — 1.3, окружение — 1.0
        # Разбиваем на блоки и оборачиваем в веса
        lines = story.split("\n\n")
        weighted = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            # Референс — 1.2
            if line.startswith("Style reference") or line.startswith("Color palette"):
                weighted.append(f"({line}:1.2)")
            elif "Main product" in line or "Key visual focus" in line:
                weighted.append(f"({line}:1.3)")
            elif "Lighting:" in line or "Camera:" in line:
                weighted.append(f"({line}:1.1)")
            elif "Mood:" in line or "Atmosphere:" in line:
                weighted.append(f"({line}:1.0)")
            else:
                weighted.append(f"({line}:1.0)")

        sdxl_body = ", ".join(weighted)

        aspect = data.get("aspect_ratio", "3:4")
        negative = data.get("negative") or (
            "dark, moody, sad, gloomy, deformed hands, "
            "extra fingers, low quality, blurry, illustration, 3D render, "
            "cartoon, painting, watermark, text, logo"
        )

        return (
            f"{sdxl_body}\n\n"
            f"Negative prompt: {negative}\n"
            f"Steps: 30, CFG: 4.0, Sampler: DPM++ 2M Karras\n"
            f"Aspect ratio: {aspect}"
        )


# ═══════════════════════════════════════════
# Сборка данных из VisualProject
# ═══════════════════════════════════════════

def extract_prompt_data(project) -> dict:
    """Извлечь все данные для экспорта из VisualProject.

    Сохраняет ПОЛНУЮ детализацию всех блоков VSL.
    """
    v = project.visual_design
    n = project.narrative
    ch = n.characters[0] if n.characters else None

    # Персонаж — максимально подробно
    char_parts = []
    if ch and ch.identity:
        char_parts.append(ch.identity)
    if ch and ch.appearance:
        char_parts.append(f"with {ch.appearance}")
    if ch and ch.wardrobe:
        char_parts.append(f"wearing {ch.wardrobe}")
    if ch and ch.pose:
        char_parts.append(f"posed {ch.pose}")
    if ch and ch.expression:
        char_parts.append(f"expression: {ch.expression}")
    char_desc = ", ".join(char_parts)

    # Камера — полное описание
    cam_parts = []
    if v.camera.shot: cam_parts.append(v.camera.shot)
    if v.camera.lens: cam_parts.append(f"{v.camera.lens} lens")
    if v.camera.angle: cam_parts.append(v.camera.angle)
    if v.camera.dof: cam_parts.append(f"depth of field: {v.camera.dof}")
    if v.camera.movement: cam_parts.append(f"camera movement: {v.camera.movement}")
    if v.camera.pov: cam_parts.append(f"point of view: {v.camera.pov}")
    if v.camera.height: cam_parts.append(f"camera height: {v.camera.height}")
    camera = ". ".join(cam_parts)

    # Освещение — полное
    light_parts = []
    if v.lighting.key: light_parts.append(f"Key light: {v.lighting.key}")
    if v.lighting.fill: light_parts.append(f"Fill light: {v.lighting.fill}")
    if v.lighting.rim: light_parts.append(f"Rim/back light: {v.lighting.rim}")
    if v.lighting.contrast: light_parts.append(f"Contrast: {v.lighting.contrast}")
    if v.lighting.temperature: light_parts.append(f"Color temperature: {v.lighting.temperature}")
    if v.lighting.shadow_quality: light_parts.append(f"Shadows: {v.lighting.shadow_quality}")
    if v.lighting.volumetric: light_parts.append(f"Volumetric effects: {v.lighting.volumetric}")
    lighting = ". ".join(light_parts)

    # Композиция
    comp_parts = []
    if v.composition.depth_layers: comp_parts.append(f"Depth layers: {v.composition.depth_layers}")
    if v.composition.negative_space: comp_parts.append(f"Negative space: {v.composition.negative_space}")
    if v.composition.leading_lines: comp_parts.append(f"Leading lines: {v.composition.leading_lines}")
    if v.composition.balance: comp_parts.append(f"Balance: {v.composition.balance}")
    if v.composition.focus: comp_parts.append(f"Focus: {v.composition.focus}")
    composition = ". ".join(comp_parts)

    # Цвета
    color_parts = []
    if v.color.palette: color_parts.append(v.color.palette)
    if v.color.accent: color_parts.append(f"Accent: {v.color.accent}")
    if v.color.temperature: color_parts.append(f"Temperature: {v.color.temperature}")
    if v.color.saturation: color_parts.append(f"Saturation: {v.color.saturation}")
    if v.color.harmony: color_parts.append(f"Harmony: {v.color.harmony}")
    colors = ". ".join(color_parts)

    # Настроение
    mood = project.intent.emotion or v.atmosphere.mood or ""
    atmosphere_desc = v.atmosphere.lighting_mood or ""
    if v.atmosphere.particles:
        atmosphere_desc += f" {v.atmosphere.particles}" if atmosphere_desc else v.atmosphere.particles

    # Стиль
    style_parts = []
    if v.style.medium: style_parts.append(v.style.medium)
    if v.style.rendering_style: style_parts.append(v.style.rendering_style)
    if v.style.film_stock: style_parts.append(f"Film stock: {v.style.film_stock}")
    if v.style.influences: style_parts.append(f"Influences: {', '.join(v.style.influences[:3])}")
    style = ". ".join(style_parts)

    # ВАЖНО: ключи должны совпадать с теми, что читает build_full_story
    # (контракт закреплён в hermes/tests/test_prompt_exporter.py)
    return {
        "environment": n.world,
        "character": char_desc,
        "product": project.intent.message or "",
        "focus": n.focus,
        "lighting": lighting,
        "camera": camera,
        "composition": composition,
        "color": colors,
        "mood": mood,
        "atmosphere": atmosphere_desc or mood,
        "style": style,
        "timeline": n.timeline,
        "aspect_ratio": project.technical.aspect_ratio or "3:4",
        "constraints": {
            "must_have": project.constraints.must_have if project.constraints else [],
            "must_not": project.constraints.must_not_have if project.constraints else [],
        },
    }