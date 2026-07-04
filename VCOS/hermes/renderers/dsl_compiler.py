"""VCOS — DSL Compiler v1 (CP-001.8)

Промежуточный DSL между графом (Semantic Graph / Registry) и Renderer'ами.

Архитектура:
  Graph (Nodes + Edges) → SemDSL (Intermediate Representation) → Prompt Format

Преимущества:
  - Единый IR для всех рендеров
  - Не зависит от структуры Graph
  - Легко тестировать (чистые функции, нет Registry)
  - Можно сохранять DSLAst как артефакт
"""

from dataclasses import dataclass, field
from typing import Optional


# ═══════════════════════════════════════════
# SemDSL — Intermediate Representation
# ═══════════════════════════════════════════

@dataclass
class SemDSLIntent:
    """Намерение: товар, концепция, категория."""
    product_type: str = ""
    color: str = ""
    material: str = ""
    features: list[str] = field(default_factory=list)
    purpose: str = ""  # зачем этот проект


@dataclass
class SemDSLCharacter:
    """Персонаж: модель, внешность, одежда, поза."""
    identity: str = ""
    appearance: str = ""
    wardrobe: str = ""
    expression: str = ""
    pose: str = ""
    action: str = ""


@dataclass
class SemDSLEnvironment:
    """Окружение: локация, время суток, погода."""
    location: str = ""
    time_of_day: str = ""
    weather: str = ""
    atmosphere_particles: str = ""


@dataclass
class SemDSLCamera:
    """Камера: объектив, ракурс, движение, глубина резкости."""
    lens: str = ""
    shot: str = ""      # wide, medium, close-up
    angle: str = ""     # eye-level, low, high, dutch
    movement: str = ""  # static, handheld, dolly
    dof: str = ""       # shallow, deep
    height: str = ""    # camera height
    pov: str = ""


@dataclass
class SemDSLLighting:
    """Освещение: ключевой, заполняющий, контровой, контраст."""
    key_light: str = ""
    fill_light: str = ""
    rim_light: str = ""
    contrast: str = ""
    temperature: str = ""
    shadow_quality: str = ""
    volumetric: str = ""


@dataclass
class SemDSLColor:
    """Цвет: палитра, акцент, температура, насыщенность."""
    palette: str = ""
    accent: str = ""
    temperature: str = ""
    saturation: str = ""
    harmony: str = ""


@dataclass
class SemDSLComposition:
    """Композиция: правило третей, глубина, баланс."""
    framing: str = ""       # classic, extreme, tight
    rule_of_thirds: str = ""
    depth_layers: str = ""
    negative_space: str = ""
    balance: str = ""
    leading_lines: str = ""
    focus: str = ""


@dataclass
class SemDSLMood:
    """Настроение и атмосфера."""
    mood: str = ""
    emotion: str = ""
    atmosphere_density: str = ""


@dataclass
class SemDSLStyle:
    """Стиль: medium, rendering, film stock, influences."""
    medium: str = ""
    rendering_style: str = ""
    film_stock: str = ""
    influences: list[str] = field(default_factory=list)
    color_grading: str = ""
    grain: str = ""


@dataclass
class SemDSLMotion:
    """Динамика: движение камеры/субъекта."""
    dynamics: str = ""
    camera_movement: str = ""
    subject_motion: str = ""


@dataclass
class SemDSLProfile:
    """Профиль режиссёра/дизайнера."""
    name: str = ""
    role: str = ""
    signature_quote: str = ""
    era: str = ""


@dataclass
class SemDSLConstraints:
    """Ограничения."""
    must_have: list[str] = field(default_factory=list)
    must_not: list[str] = field(default_factory=list)
    general: list[str] = field(default_factory=list)


@dataclass
class SemDSLReference:
    """Референс."""
    enabled: bool = False
    description: str = ""
    style: str = ""
    composition: str = ""
    lighting: str = ""
    color: str = ""


# ═══════════════════════════════════════════
# Root DSL — полное описание сцены
# ═══════════════════════════════════════════

@dataclass
class SemDSL:
    """Семантический DSL — полное промежуточное представление сцены.

    Всегда полный, независимо от того, какие поля заполнены.
    Renderer решает, что показывать.
    """
    intent: SemDSLIntent = field(default_factory=SemDSLIntent)
    character: SemDSLCharacter = field(default_factory=SemDSLCharacter)
    environment: SemDSLEnvironment = field(default_factory=SemDSLEnvironment)
    camera: SemDSLCamera = field(default_factory=SemDSLCamera)
    lighting: SemDSLLighting = field(default_factory=SemDSLLighting)
    color: SemDSLColor = field(default_factory=SemDSLColor)
    composition: SemDSLComposition = field(default_factory=SemDSLComposition)
    mood: SemDSLMood = field(default_factory=SemDSLMood)
    style: SemDSLStyle = field(default_factory=SemDSLStyle)
    motion: SemDSLMotion = field(default_factory=SemDSLMotion)
    profile: SemDSLProfile = field(default_factory=SemDSLProfile)
    constraints: SemDSLConstraints = field(default_factory=SemDSLConstraints)
    reference: SemDSLReference = field(default_factory=SemDSLReference)

    aspect_ratio: str = "3:4"
    model_target: str = "chatgpt"
    domain: list[str] = field(default_factory=list)

    # Доменные переопределения рендера (пусто → дефолт коммерческой фотографии)
    style_defaults: str = ""
    negative: str = ""

    @property
    def is_empty(self) -> bool:
        """Проверить, что DSL пуст."""
        return all([
            not self.intent.product_type,
            not self.character.identity,
            not self.environment.location,
        ])


# ═══════════════════════════════════════════
# Compiler: graph data → SemDSL
# ═══════════════════════════════════════════

def compile_to_dsl(project_data: dict) -> SemDSL:
    """Скомпилировать плоский dict из project_data() в SemDSL.

    Args:
        project_data: dict из graph_adapter.project_data()
                      (или extract_prompt_data())

    Returns:
        SemDSL — полное структурированное представление
    """
    dsl = SemDSL()

    # Parse intent blocks
    intent_text = project_data.get("intent", "")
    if intent_text:
        # Разбираем field: value пары
        fields = _parse_fields(intent_text)
        dsl.intent.product_type = fields.get("type", fields.get("product_type", ""))
        dsl.intent.color = fields.get("color", "")
        dsl.intent.material = fields.get("material", "")
        dsl.intent.features = [v for f, v in fields.items()
                               if f not in ("type", "color", "material", "purpose")]
        dsl.intent.purpose = fields.get("purpose", "")

    # Character
    char_text = project_data.get("character", "")
    if char_text:
        fields = _parse_fields(char_text)
        dsl.character.identity = fields.get("identity", fields.get("model", ""))
        dsl.character.appearance = fields.get("appearance", "")
        dsl.character.wardrobe = fields.get("wardrobe", "")
        dsl.character.expression = fields.get("expression", "")
        dsl.character.pose = fields.get("pose", "")
        dsl.character.action = fields.get("action", "")

    # Environment
    env_text = project_data.get("environment", "")
    if not env_text:
        env_text = project_data.get("narrative", "")
    if env_text:
        fields = _parse_fields(env_text)
        dsl.environment.location = fields.get("location", fields.get("setting", ""))
        dsl.environment.time_of_day = fields.get("time_of_day", fields.get("time", ""))
        dsl.environment.weather = fields.get("weather", "")
        dsl.environment.atmosphere_particles = fields.get("particles", "")

    # Composition
    comp_text = project_data.get("composition", "")
    if comp_text:
        fields = _parse_fields(comp_text)
        dsl.composition.framing = fields.get("framing", "")
        dsl.composition.rule_of_thirds = fields.get("rule_of_thirds", "")
        dsl.composition.depth_layers = fields.get("depth", fields.get("depth_layers", ""))
        dsl.composition.negative_space = fields.get("negative_space", "")
        dsl.composition.balance = fields.get("balance", "")
        dsl.composition.leading_lines = fields.get("leading_lines", "")
        dsl.composition.focus = fields.get("focus", "")

    # Camera
    cam_text = project_data.get("camera", "")
    if cam_text:
        fields = _parse_fields(cam_text)
        dsl.camera.lens = fields.get("lens", "")
        dsl.camera.shot = fields.get("shot", "")
        dsl.camera.angle = fields.get("angle", "")
        dsl.camera.movement = fields.get("movement", "")
        dsl.camera.dof = fields.get("dof", "")
        dsl.camera.height = fields.get("height", "")
        dsl.camera.pov = fields.get("pov", "")

    # Lighting
    light_text = project_data.get("lighting", "")
    if light_text:
        fields = _parse_fields(light_text)
        dsl.lighting.key_light = fields.get("key", fields.get("key_light", ""))
        dsl.lighting.fill_light = fields.get("fill", fields.get("fill_light", ""))
        dsl.lighting.rim_light = fields.get("rim", fields.get("rim_light",
                                            fields.get("back", "")))
        dsl.lighting.contrast = fields.get("contrast", "")
        dsl.lighting.temperature = fields.get("temperature", "")
        dsl.lighting.shadow_quality = fields.get("shadow_quality", "")
        dsl.lighting.volumetric = fields.get("volumetric", "")

    # Color
    color_text = project_data.get("color", "")
    if not color_text:
        color_text = project_data.get("colors", "")
    if color_text:
        fields = _parse_fields(color_text)
        dsl.color.palette = fields.get("palette", "")
        dsl.color.accent = fields.get("accent", fields.get("accent_color", ""))
        dsl.color.temperature = fields.get("temperature", "")
        dsl.color.saturation = fields.get("saturation", "")
        dsl.color.harmony = fields.get("harmony", "")

    # Style
    style_text = project_data.get("style", "")
    if style_text:
        fields = _parse_fields(style_text)
        dsl.style.medium = fields.get("medium", "")
        dsl.style.rendering_style = fields.get("rendering_style", fields.get("style", ""))
        dsl.style.film_stock = fields.get("film_stock", "")
        dsl.style.color_grading = fields.get("color_grading", "")
        dsl.style.grain = fields.get("grain", "")

    # Mood
    mood_text = project_data.get("mood", "")
    if mood_text:
        fields = _parse_fields(mood_text)
        dsl.mood.mood = fields.get("mood", mood_text)
        dsl.mood.emotion = fields.get("emotion", "")
        dsl.mood.atmosphere_density = fields.get("atmosphere_density", "")

    # Motion
    motion_text = project_data.get("motion", "")
    if motion_text:
        fields = _parse_fields(motion_text)
        dsl.motion.dynamics = fields.get("dynamics", "")
        dsl.motion.camera_movement = fields.get("camera_movement", "")
        dsl.motion.subject_motion = fields.get("subject_motion", "")

    # Profile
    profile_name = project_data.get("profile", "")
    if profile_name:
        dsl.profile.name = profile_name
        dsl.profile.role = "🎬 Director Profile"

    # Constraints
    must_have_text = project_data.get("must_have", "")
    must_not_text = project_data.get("must_not", "")
    if isinstance(must_have_text, str) and must_have_text:
        dsl.constraints.must_have = [must_have_text]
    if isinstance(must_not_text, str) and must_not_text:
        dsl.constraints.must_not = [must_not_text]

    # Meta
    dsl.aspect_ratio = project_data.get("aspect_ratio", "3:4")
    dsl.model_target = project_data.get("model_target", "chatgpt")
    dsl.style_defaults = project_data.get("style_defaults", "") or ""
    dsl.negative = project_data.get("negative", "") or ""
    dsl.domain = project_data.get("category", "").split(", ") if isinstance(
        project_data.get("category"), str) else []

    # Reference
    ref_enabled = project_data.get("reference_enabled", False)
    if ref_enabled or project_data.get("reference"):
        dsl.reference.enabled = True
        dsl.reference.description = str(project_data.get("reference", ""))

    return dsl


def _parse_fields(text: str) -> dict[str, str]:
    """Разобрать строку 'field: value; field2: value2' в dict.

    Поддерживает:
      - field: value (разделитель ',', ';', новая строка)
      - bare text (без field:) — ключ 'text'
    """
    result = {}
    parts = text.replace("; ", ";").replace(", ", ",").split(";")
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            key, _, value = part.partition(":")
            result[key.strip()] = value.strip()
        else:
            # Bare text — просто текст
            result.setdefault("text", part)

    if not result:
        result["text"] = text

    return result


# ═══════════════════════════════════════════
# Compiler: SemDSL → Prompt (model-aware)
# ═══════════════════════════════════════════

def compile_to_prompt(dsl: SemDSL, model: str = "chatgpt") -> str:
    """Скомпилировать SemDSL в промпт для указанной модели.

    Args:
        dsl: SemDSL — промежуточное представление
        model: 'chatgpt', 'midjourney', 'nanobanana', 'flux', 'sdxl'

    Returns:
        Готовый промпт
    """
    # Сначала строим полное story (независимо от модели)
    story = _dsl_to_story(dsl)

    # Модель-специфичная обёртка
    formatters = {
        "chatgpt": _format_chatgpt,
        "midjourney": _format_midjourney,
        "nanobanana": _format_nanobanana,
        "flux": _format_flux,
        "sdxl": _format_sdxl,
    }
    formatter = formatters.get(model, _format_chatgpt)
    return formatter(story, dsl)


def _dsl_to_story(dsl: SemDSL) -> str:
    """SemDSL → структурированное описание на естественном языке.

    Формирует абзацы только для НЕПУСТЫХ блоков.
    """
    paragraphs = []

    # Reference
    if dsl.reference and dsl.reference.enabled and dsl.reference.description:
        paragraphs.append(f"🖼 Style reference: {dsl.reference.description}")

    # Intent
    intent_parts = []
    if dsl.intent.product_type:
        intent_parts.append(dsl.intent.product_type)
    if dsl.intent.color:
        intent_parts.append(f"color: {dsl.intent.color}")
    if dsl.intent.material:
        intent_parts.append(f"material: {dsl.intent.material}")
    if dsl.intent.features:
        intent_parts.extend(dsl.intent.features)
    if intent_parts:
        paragraphs.append(f"🎬 Concept: {', '.join(intent_parts)}")
    elif dsl.domain:
        paragraphs.append(f"🎬 Product photo: {', '.join(dsl.domain)}")

    # Character
    char_parts = []
    if dsl.character.identity:
        char_parts.append(dsl.character.identity)
    if dsl.character.appearance:
        char_parts.append(f"appearance: {dsl.character.appearance}")
    if dsl.character.wardrobe:
        char_parts.append(f"wearing {dsl.character.wardrobe}")
    if dsl.character.pose:
        char_parts.append(f"pose: {dsl.character.pose}")
    if dsl.character.expression:
        char_parts.append(f"expression: {dsl.character.expression}")
    if dsl.character.action:
        char_parts.append(f"action: {dsl.character.action}")
    if char_parts:
        paragraphs.append(f"👤 Character: {', '.join(char_parts)}")

    # Environment
    env_parts = []
    if dsl.environment.location:
        env_parts.append(dsl.environment.location)
    if dsl.environment.time_of_day:
        env_parts.append(dsl.environment.time_of_day)
    if dsl.environment.weather:
        env_parts.append(dsl.environment.weather)
    if dsl.environment.atmosphere_particles:
        env_parts.append(dsl.environment.atmosphere_particles)
    if env_parts:
        paragraphs.append(f"🌍 Setting: {', '.join(env_parts)}")

    # Composition
    comp_parts = []
    if dsl.composition.framing:
        comp_parts.append(f"framing: {dsl.composition.framing}")
    if dsl.composition.rule_of_thirds:
        comp_parts.append(dsl.composition.rule_of_thirds)
    if dsl.composition.depth_layers:
        comp_parts.append(f"depth: {dsl.composition.depth_layers}")
    if dsl.composition.negative_space:
        comp_parts.append(f"negative space: {dsl.composition.negative_space}")
    if dsl.composition.balance:
        comp_parts.append(f"balance: {dsl.composition.balance}")
    if dsl.composition.leading_lines:
        comp_parts.append(f"leading lines: {dsl.composition.leading_lines}")
    if dsl.composition.focus:
        comp_parts.append(f"focus: {dsl.composition.focus}")
    if comp_parts:
        paragraphs.append(f"📐 Composition: {', '.join(comp_parts)}")

    # Camera
    cam_parts = []
    if dsl.camera.lens:
        cam_parts.append(f"{dsl.camera.lens} lens")
    if dsl.camera.shot:
        cam_parts.append(dsl.camera.shot)
    if dsl.camera.angle:
        cam_parts.append(dsl.camera.angle)
    if dsl.camera.movement:
        cam_parts.append(f"camera movement: {dsl.camera.movement}")
    if dsl.camera.dof:
        cam_parts.append(f"depth of field: {dsl.camera.dof}")
    if dsl.camera.pov:
        cam_parts.append(f"POV: {dsl.camera.pov}")
    if cam_parts:
        paragraphs.append(f"🎥 Camera: {', '.join(cam_parts)}")

    # Lighting
    light_parts = []
    if dsl.lighting.key_light:
        light_parts.append(f"Key light: {dsl.lighting.key_light}")
    if dsl.lighting.fill_light:
        light_parts.append(f"Fill light: {dsl.lighting.fill_light}")
    if dsl.lighting.rim_light:
        light_parts.append(f"Rim/back light: {dsl.lighting.rim_light}")
    if dsl.lighting.contrast:
        light_parts.append(f"Contrast: {dsl.lighting.contrast}")
    if dsl.lighting.temperature:
        light_parts.append(f"Temperature: {dsl.lighting.temperature}")
    if dsl.lighting.shadow_quality:
        light_parts.append(f"Shadows: {dsl.lighting.shadow_quality}")
    if dsl.lighting.volumetric:
        light_parts.append(f"Volumetric: {dsl.lighting.volumetric}")
    if light_parts:
        paragraphs.append(f"💡 Lighting: {', '.join(light_parts)}")

    # Color
    color_parts = []
    if dsl.color.palette:
        color_parts.append(dsl.color.palette)
    if dsl.color.accent:
        color_parts.append(f"Accent: {dsl.color.accent}")
    if dsl.color.temperature:
        color_parts.append(f"Temperature: {dsl.color.temperature}")
    if dsl.color.saturation:
        color_parts.append(f"Saturation: {dsl.color.saturation}")
    if dsl.color.harmony:
        color_parts.append(f"Harmony: {dsl.color.harmony}")
    if color_parts:
        paragraphs.append(f"🎨 Colors: {', '.join(color_parts)}")

    # Mood
    mood_parts = []
    if dsl.mood.mood:
        mood_parts.append(dsl.mood.mood)
    if dsl.mood.atmosphere_density:
        mood_parts.append(f"atmosphere: {dsl.mood.atmosphere_density}")
    if mood_parts:
        paragraphs.append(f"💭 Mood: {', '.join(mood_parts)}")
    if dsl.mood.emotion:
        paragraphs.append(f"😊 Emotion: {dsl.mood.emotion}")

    # Motion
    motion_parts = []
    if dsl.motion.dynamics:
        motion_parts.append(f"dynamics: {dsl.motion.dynamics}")
    if dsl.motion.camera_movement:
        motion_parts.append(f"camera movement: {dsl.motion.camera_movement}")
    if dsl.motion.subject_motion:
        motion_parts.append(f"subject motion: {dsl.motion.subject_motion}")
    if motion_parts:
        paragraphs.append(f"🎬 Motion: {', '.join(motion_parts)}")

    # Style
    style_parts = []
    if dsl.style.medium:
        style_parts.append(dsl.style.medium)
    if dsl.style.rendering_style:
        style_parts.append(dsl.style.rendering_style)
    if dsl.style.film_stock:
        style_parts.append(f"Film stock: {dsl.style.film_stock}")
    if dsl.style.color_grading:
        style_parts.append(f"Grading: {dsl.style.color_grading}")
    if dsl.style.grain:
        style_parts.append(f"Grain: {dsl.style.grain}")
    if dsl.style.influences:
        style_parts.append(f"Influences: {', '.join(dsl.style.influences)}")
    if style_parts:
        paragraphs.append(f"🎬 Style: {', '.join(style_parts)}")

    # Constraints
    constraint_parts = []
    if dsl.constraints.must_have:
        for c in dsl.constraints.must_have:
            constraint_parts.append(f"must: {c}")
    if dsl.constraints.must_not:
        for c in dsl.constraints.must_not:
            constraint_parts.append(f"avoid: {c}")
    if dsl.constraints.general:
        for c in dsl.constraints.general:
            constraint_parts.append(c)
    if constraint_parts:
        paragraphs.append(f"🚫 Constraints: {'; '.join(constraint_parts)}")

    # Profile
    if dsl.profile.name:
        paragraphs.append(f"🎭 Profile: {dsl.profile.name}")

    return "\n\n".join(p for p in paragraphs if p)


# ═══════════════════════════════════════════
# Model formatters
# ═══════════════════════════════════════════

def _format_chatgpt(story: str, dsl: SemDSL) -> str:
    """ChatGPT / DALL-E 3: полный текст + техспеки."""
    style_line = dsl.style_defaults or (
        "commercial product photography, not illustration, not 3D render"
    )
    tech = (
        f"\n\n--- TECHNICAL SPECIFICATION ---\n"
        f"Aspect ratio: {dsl.aspect_ratio}\n"
        f"Quality: photorealistic, ultra-detailed, 4K resolution\n"
        f"Style: {style_line}\n"
        f"Output: realistic photographic image, high detail, natural textures"
    )
    return story + tech


def _format_midjourney(story: str, dsl: SemDSL) -> str:
    """Midjourney v6: абзацы → строки, параметры в конце."""
    lines = story.split("\n\n")
    mj_body = "\n".join(line.strip() for line in lines if line.strip())

    ar_map = {
        "3:4": "--ar 3:4", "9:16": "--ar 9:16", "1:1": "--ar 1:1",
        "16:9": "--ar 16:9", "4:5": "--ar 4:5",
    }
    ar_param = ar_map.get(dsl.aspect_ratio, f"--ar {dsl.aspect_ratio}")

    return f"{mj_body}\n\n{ar_param} --v 6 --style raw --s 250"


def _format_nanobanana(story: str, dsl: SemDSL) -> str:
    """Nano Banana Pro: story + tech."""
    style_line = dsl.style_defaults or "commercial product photography"
    tech = (
        f"\n\n--- Technical ---\n"
        f"Aspect ratio: {dsl.aspect_ratio}\n"
        f"Quality: photorealistic, 4K\n"
        f"Style: {style_line}"
    )
    return story + tech


def _format_flux(story: str, dsl: SemDSL) -> str:
    """Flux Pro: story + aspect ratio."""
    style_line = dsl.style_defaults or (
        "Photorealistic, high detail, commercial photography"
    )
    return (
        f"{story}\n\n"
        f"Aspect ratio: {dsl.aspect_ratio}. "
        f"{style_line}."
    )


def _format_sdxl(story: str, dsl: SemDSL) -> str:
    """SDXL: веса + negative prompt."""
    lines = story.split("\n\n")
    weighted = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("🖼") or line.startswith("🎨") or line.startswith("💡"):
            weighted.append(f"({line}:1.2)")
        elif "Camera:" in line or "Composition:" in line:
            weighted.append(f"({line}:1.1)")
        elif "🎬 Concept" in line or "👤 Character" in line:
            weighted.append(f"({line}:1.3)")
        else:
            weighted.append(f"({line}:1.0)")

    sdxl_body = ", ".join(weighted)

    negative = dsl.negative or (
        "dark, moody, sad, gloomy, deformed hands, "
        "extra fingers, low quality, blurry, illustration, 3D render, "
        "cartoon, painting, watermark, text, logo"
    )

    return (
        f"{sdxl_body}\n\n"
        f"Negative prompt: {negative}\n"
        f"Steps: 30, CFG: 4.0, Sampler: DPM++ 2M Karras\n"
        f"Aspect ratio: {dsl.aspect_ratio}"
    )


# ═══════════════════════════════════════════
# Compiler class
# ═══════════════════════════════════════════

class DSLCompiler:
    """DSL Compiler v1 — из graph data в промпт через SemDSL.

    Использование:
        compiler = DSLCompiler()

        # Шаг 1: graph data → SemDSL
        dsl = compiler.compile(project_data)

        # Шаг 2: SemDSL → prompt
        prompt = compiler.render(dsl, "chatgpt")

        # Или одной строкой:
        prompt = compiler.full_compile(project_data, "chatgpt")
    """

    def compile(self, project_data: dict) -> SemDSL:
        """Graph data → SemDSL."""
        return compile_to_dsl(project_data)

    def render(self, dsl: SemDSL, model: str = "chatgpt") -> str:
        """SemDSL → Prompt."""
        return compile_to_prompt(dsl, model)

    def full_compile(self, project_data: Optional[dict], model: str = "chatgpt") -> str:
        """Graph data → Prompt (full pipeline)."""
        if not project_data:
            return ""
        dsl = self.compile(project_data)
        return self.render(dsl, model)