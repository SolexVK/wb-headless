"""VCOS — Director Profiles v1

Профили режиссёров, дизайнеров и маркетологов.
Каждый профиль — ~20 параметров, влияющих на все блоки VSL.

Три слоя:
  🎬 Кинорежиссёры — визуальный язык, кадр, свет, настроение
  🎨 Дизайнеры — форма, эстетика, бренд, современный коммерческий стиль
  📈 Маркетологи — продажа, внимание, психология, конверсия через визуал

Система:
  1. Пользователь выбирает профиль (или "авто" — подбор по контексту)
  2. Профиль диктует сигнатуру по 20 параметрам
  3. Inference Engine достраивает остальное в духе выбранного профиля
"""

from dataclasses import dataclass, field
from typing import Optional


# ═══════════════════════════════════════════
# Профиль режиссёра/дизайнера/маркетолога
# ═══════════════════════════════════════════

@dataclass
class DirectorProfile:
    """Профиль режиссёра — 20 параметров визуального языка."""
    
    # ─── Идентификация ───
    name: str                                  # Имя
    role: str = "🎬 Кинорежиссёр"              # 🎬 🎨 📈
    era: str = ""                              # 1950s, 1970s, 2000s, contemporary
    signature_quote: str = ""                  # Фирменная цитата о визуале
    
    # ─── 1. ЦВЕТ И ПАЛИТРА ───
    color_signature: str = ""                  # Фирменная палитра
    color_temperature: str = "neutral"         # warm / cool / neutral / mixed
    color_saturation: str = "natural"          # vibrant / muted / desaturated / natural
    color_harmony: str = "analogous"           # complementary / analogous / monochrome / triadic
    accent_color_philosophy: str = ""          # Как использует акцентные цвета
    
    # ─── 2. ОСВЕЩЕНИЕ ───
    light_signature: str = ""                  # Фирменный свет
    light_contrast: str = "medium"             # high / medium / low / variable
    light_temperature: str = "neutral"         # warm / cool / mixed
    shadow_quality: str = "soft"               # hard / soft / diffused / no_shadows
    light_key: str = "natural"                 # natural / studio / mixed / dramatic
    
    # ─── 3. КАМЕРА И ОПТИКА ───
    lens_preference: str = ""                  # Предпочитаемые объективы
    focal_length_style: str = "normal"         # wide / normal / tele / variable
    camera_movement: str = "static"            # static / handheld / dolly / steadicam / mixed
    framing_style: str = "classic"             # classic / extreme / tight / wide / variable
    
    # ─── 4. КОМПОЗИЦИЯ ───
    composition_signature: str = ""            # Фирменная композиция
    symmetry_preference: str = "balanced"      # symmetric / asymmetric / dynamic / balanced
    depth_layers: str = "moderate"             # shallow / moderate / deep / extreme
    negative_space_use: str = "moderate"       # minimal / moderate / extensive / dramatic
    rule_of_thirds: str = "respects"           # respects / breaks / ignores / variable
    
    # ─── 5. АТМОСФЕРА И НАСТРОЕНИЕ ───
    mood_signature: str = ""                   # Фирменное настроение
    atmosphere_density: str = "clear"          # clear / hazy / foggy / smoky / variable
    emotional_target: str = ""                 # Целевая эмоция

    # ─── 6. ДИНАМИКА И ДВИЖЕНИЕ ───
    dynamics: str = "calm"                     # calm / energetic / dramatic / variable
    subject_motion: str = "minimal"            # minimal / natural / choreographed / dynamic
    
    # ─── 7. ДЕТАЛИ И ТЕКСТУРЫ ───
    texture_focus: str = "moderate"            # minimal / moderate / high / extreme
    detail_philosophy: str = ""                # Как работает с деталями
    
    # ─── 8. ПОСТ-ПРОЦЕССИНГ ───
    film_stock_signature: str = ""             # Предпочитаемая плёнка/стилизация
    grain_use: str = "minimal"                 # none / minimal / moderate / heavy
    color_grading: str = "natural"             # natural / stylized / bleach_bypass / teal_orange
    
    # ─── 9. ПРОДУКЦИЯ ───
    scale_preference: str = "intimate"         # intimate / medium / epic / variable
    set_design: str = "minimal"                # minimal / realistic / stylized / theatrical
    
    # ─── 10. ПОДПИСЬ ───
    signature_element: str = ""                # Фирменный приём (дождь, отражения, зерно...)
    
    def summary(self) -> str:
        """Краткая сводка профиля."""
        lines = [
            f"{self.role} **{self.name}**",
            f"  🎨 Цвет: {self.color_signature or '—'}",
            f"  💡 Свет: {self.light_signature or '—'}",
            f"  📐 Композиция: {self.composition_signature or '—'}",
            f"  🎥 Камера: {self.lens_preference or '—'}, {self.framing_style}",
            f"  🌫 Настроение: {self.mood_signature or '—'}",
            f"  ✨ Фирменный приём: {self.signature_element or '—'}",
        ]
        return "\n".join(lines)


# ═══════════════════════════════════════════
# СЛОВАРЬ ПРОФИЛЕЙ
# ═══════════════════════════════════════════

# Определяем все профили

DIRECTORS = {}  # будет заполнено ниже

# ─── 🎬 КИНОРЕЖИССЁРЫ ────────────────────

DIRECTORS["куросава"] = DirectorProfile(
    name="Акира Куросава",
    era="1950s-1990s",
    signature_quote="В кино нужно показывать не то, что видит камера, а то, что видит глаз.",
    color_signature="Природная палитра: охра, зелень, синева неба",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Красный как акцент жизни/смерти среди природных тонов",
    light_signature="Контрастный естественный свет, работа с погодой",
    light_contrast="high",
    light_temperature="warm",
    shadow_quality="hard",
    light_key="natural",
    lens_preference="Широкие углы (35-40mm), телеобъективы для сжатия",
    focal_length_style="wide",
    camera_movement="dynamic",
    framing_style="dynamic",
    composition_signature="Многослойная: передний-средний-задний план, движение внутри кадра",
    symmetry_preference="dynamic",
    depth_layers="deep",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Эпическое спокойствие, принятие неизбежного",
    atmosphere_density="variable",
    emotional_target="Катарсис, принятие, мудрость",
    dynamics="dramatic",
    subject_motion="choreographed",
    texture_focus="high",
    detail_philosophy="Каждая деталь работает на атмосферу: дождь, ветер, пыль",
    film_stock_signature="Плёнка с высокой контрастностью, тёплые тона",
    grain_use="moderate",
    color_grading="natural",
    scale_preference="epic",
    set_design="realistic",
    signature_element="Погода как персонаж: дождь, ветер, пыль, туман",
)

DIRECTORS["кубрик"] = DirectorProfile(
    name="Стэнли Кубрик",
    era="1960s-1990s",
    signature_quote="Камера не просто показывает. Камера решает, что зритель видит, а что нет.",
    color_signature="Холодная, стерильная: белый, серый, синий с красными акцентами",
    color_temperature="cool",
    color_saturation="moderate",
    color_harmony="monochrome",
    accent_color_philosophy="Один акцентный цвет (красный) на холодном фоне как символ опасности",
    light_signature="Жёсткий верхний свет, естественный свет из окон, операторские люстры",
    light_contrast="high",
    light_temperature="cool",
    shadow_quality="hard",
    light_key="studio",
    lens_preference="Сверхширокий угол (18mm) для однточечной перспективы, 50mm",
    focal_length_style="wide",
    camera_movement="static",
    framing_style="extreme",
    composition_signature="Идеальная симметрия, однточечная перспектива, центрирование",
    symmetry_preference="symmetric",
    depth_layers="deep",
    negative_space_use="extensive",
    rule_of_thirds="breaks",
    mood_signature="Отчуждение, контроль, холодное наблюдение",
    atmosphere_density="clear",
    emotional_target="Интеллектуальное напряжение, дискомфорт осознания",
    dynamics="calm",
    subject_motion="minimal",
    texture_focus="high",
    detail_philosophy="Стерильная чистота, каждый предмет на своём месте",
    film_stock_signature="Чистый, стерильный образ, минимальное зерно",
    grain_use="minimal",
    color_grading="stylized",
    scale_preference="epic",
    set_design="stylized",
    signature_element="Однточечная перспектива с уходящими линиями, симметрия",
)

DIRECTORS["тарантино"] = DirectorProfile(
    name="Квентин Тарантино",
    era="1990s-2020s",
    signature_quote="Диалог — это музыка. А кадр — это удар.",
    color_signature="Насыщенные, почти мультяшные: красный, жёлтый, синий, белый",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Красный как драматический акцент, жёлтый как тревога/энергия",
    light_signature="Стилизованный свет: неон, контрастные тени, источники в кадре",
    light_contrast="high",
    light_temperature="warm",
    shadow_quality="hard",
    light_key="mixed",
    lens_preference="Широкий угол для экспрессии, 35mm для диалогов",
    focal_length_style="wide",
    camera_movement="dynamic",
    framing_style="extreme",
    composition_signature="Экспрессивная, динамичная, низкие ракурсы, trunk shots",
    symmetry_preference="dynamic",
    depth_layers="moderate",
    negative_space_use="minimal",
    rule_of_thirds="respects",
    mood_signature="Игривая напряжённость, стилизованная жестокость, крутизна",
    atmosphere_density="clear",
    emotional_target="Адреналин, стиль, напряжение с юмором",
    dynamics="energetic",
    subject_motion="choreographed",
    texture_focus="moderate",
    detail_philosophy="Предметы как символы статуса: оружие, обувь, коктейли",
    film_stock_signature="Насыщенная плёнка, тёплые тона Kodak",
    grain_use="moderate",
    color_grading="stylized",
    scale_preference="intimate",
    set_design="stylized",
    signature_element="Trunk shot (из багажника), крупные планы ног, низкие ракурсы",
)

DIRECTORS["спилберг"] = DirectorProfile(
    name="Стивен Спилберг",
    era="1970s-2020s",
    signature_quote="Кино — это окно в другой мир. Сделай так, чтобы зрителю захотелось туда войти.",
    color_signature="Тёплая, уютная палитра: золотой, оранжевый, тёплый синий",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="analogous",
    accent_color_philosophy="Тёплый свет как эмоциональный акцент, золотой час",
    light_signature="Волшебный свет: золотой час, мягкие линзовые блики, свет сквозь листву",
    light_contrast="medium",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="natural",
    lens_preference="Широкий (24mm) для эпического, 50mm для интимного",
    focal_length_style="wide",
    camera_movement="dynamic",
    framing_style="classic",
    composition_signature="Лицо + окружение: широкий план переходит в крупный",
    symmetry_preference="balanced",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Теплота, чудо, эпическое приключение",
    atmosphere_density="clear",
    emotional_target="Искренняя эмоция, удивление, вера в чудо",
    dynamics="energetic",
    subject_motion="natural",
    texture_focus="moderate",
    detail_philosophy="Детали работают на чудо: свет в волосах, пыль в луче, глаза ребёнка",
    film_stock_signature="Kodak Vision, тёплые тона, мягкий контраст",
    grain_use="minimal",
    color_grading="natural",
    scale_preference="epic",
    set_design="realistic",
    signature_element="Dolly zoom, лицо на фоне широкого плана, золотой час",
)

DIRECTORS["нолан"] = DirectorProfile(
    name="Кристофер Нолан",
    era="2000s-2020s",
    signature_quote="Я не верю в цифру. Только плёнка даёт изображению вес.",
    color_signature="Холодная, стальная: сине-серый, белый, чёрный",
    color_temperature="cool",
    color_saturation="muted",
    color_harmony="monochrome",
    accent_color_philosophy="Минимум цвета: только когда он несёт информацию",
    light_signature="Практический свет: источники в кадре, натуральный свет, IMAX-качество",
    light_contrast="high",
    light_temperature="cool",
    shadow_quality="hard",
    light_key="mixed",
    lens_preference="IMAX камеры, широкий угол для эпичности, крупные планы на 50mm",
    focal_length_style="wide",
    camera_movement="mixed",
    framing_style="classic",
    composition_signature="Точёные линии, архитектурная строгость, масштаб",
    symmetry_preference="balanced",
    depth_layers="deep",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Интеллектуальная напряжённость, эпическая серьёзность",
    atmosphere_density="clear",
    emotional_target="Благоговение, потерянность в масштабе, интеллектуальный вызов",
    dynamics="energetic",
    subject_motion="natural",
    texture_focus="high",
    detail_philosophy="Каждая текстура реальна: практические эффекты, настоящие материалы",
    film_stock_signature="IMAX 70mm Kodak, минимальная цветокоррекция",
    grain_use="minimal",
    color_grading="natural",
    scale_preference="epic",
    set_design="realistic",
    signature_element="Практические эффекты, IMAX, временные сдвиги в монтаже",
)

DIRECTORS["тарковский"] = DirectorProfile(
    name="Андрей Тарковский",
    era="1960s-1980s",
    signature_quote="Кино — это запечатлённое время.",
    color_signature="Природная палитра: белый, серый, охра, зелень, цвета земли",
    color_temperature="cool",
    color_saturation="muted",
    color_harmony="analogous",
    accent_color_philosophy="Природные акценты: красное яблоко, зелёная трава, белый снег",
    light_signature="Поэтичный естественный свет, свет сквозь воду/листву, отражения",
    light_contrast="medium",
    light_temperature="cool",
    shadow_quality="soft",
    light_key="natural",
    lens_preference="Широкий угол, глубокий фокус, долгие планы",
    focal_length_style="wide",
    camera_movement="static",
    framing_style="classic",
    composition_signature="Поэтическая, медитативная, вода/огонь/земля как полноправные участники",
    symmetry_preference="balanced",
    depth_layers="deep",
    negative_space_use="extensive",
    rule_of_thirds="respects",
    mood_signature="Медитативная тоска, духовный поиск, ностальгия",
    atmosphere_density="hazy",
    emotional_target="Ностальгия, очищение, духовное прозрение",
    dynamics="calm",
    subject_motion="minimal",
    texture_focus="high",
    detail_philosophy="Стихии как главные герои: вода течёт, огонь горит, трава колышется",
    film_stock_signature="Советская плёнка, низкая контрастность, серые тона Kodak",
    grain_use="moderate",
    color_grading="natural",
    scale_preference="epic",
    set_design="realistic",
    signature_element="Долгие планы, вода, отражения, сны, зеркала",
)

DIRECTORS["скорсезе"] = DirectorProfile(
    name="Мартин Скорсезе",
    era="1970s-2020s",
    signature_quote="Кино — это кадр за кадром. Уважай каждый.",
    color_signature="Городская палитра: красный, коричневый, золотой, грязно-белый",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Красный как жизнь/опасность среди грязных тонов города",
    light_signature="Неровный, «грязный» свет: неон, уличные фонари, тени",
    light_contrast="high",
    light_temperature="warm",
    shadow_quality="hard",
    light_key="mixed",
    lens_preference="Широкий угол для экспрессии, крупные планы на 40mm",
    focal_length_style="wide",
    camera_movement="dynamic",
    framing_style="tight",
    composition_signature="Динамическая: камера всегда в движении, захлёбывающаяся энергия",
    symmetry_preference="dynamic",
    depth_layers="moderate",
    negative_space_use="minimal",
    rule_of_thirds="breaks",
    mood_signature="Нервная энергия, вина, искупление, городская жизнь",
    atmosphere_density="hazy",
    emotional_target="Нервная энергия, катарсис через вину, признание",
    dynamics="energetic",
    subject_motion="choreographed",
    texture_focus="high",
    detail_philosophy="Грязь, пот, кровь — реальность как текстура жизни",
    film_stock_signature="Kodak Vision, тёплые тона, зернистость 80-х",
    grain_use="moderate",
    color_grading="natural",
    scale_preference="intimate",
    set_design="realistic",
    signature_element="Steadicam point-of-view, jump cuts, дверные проёмы",
)

DIRECTORS["хичкок"] = DirectorProfile(
    name="Альфред Хичкок",
    era="1940s-1970s",
    signature_quote="Чем лучше злодей, тем лучше фильм.",
    color_signature="Чёрно-белое/приглушённое: серый, тёмные тона, резкие акценты",
    color_temperature="cool",
    color_saturation="muted",
    color_harmony="monochrome",
    accent_color_philosophy="Цвет как шок: красный плащ в чёрно-белом кадре",
    light_signature="Драматические тени, контрастный свет, силуэты, контровой",
    light_contrast="high",
    light_temperature="cool",
    shadow_quality="hard",
    light_key="dramatic",
    lens_preference="50mm для естественного взгляда, зум для vertigo",
    focal_length_style="normal",
    camera_movement="dynamic",
    framing_style="tight",
    composition_signature="Субъективная камера, тени как угроза, лестницы и двери",
    symmetry_preference="balanced",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Напряжение, паранойя, страх неизвестного",
    atmosphere_density="hazy",
    emotional_target="Тревога, саспенс, облегчение",
    dynamics="dramatic",
    subject_motion="choreographed",
    texture_focus="moderate",
    detail_philosophy="Каждая деталь — ключ к разгадке или угроза",
    film_stock_signature="Чёрно-белая плёнка с высоким контрастом",
    grain_use="moderate",
    color_grading="stylized",
    scale_preference="intimate",
    set_design="stylized",
    signature_element="Vertigo effect (dolly zoom), субъективная камера, силуэты",
)

DIRECTORS["бергман"] = DirectorProfile(
    name="Ингмар Бергман",
    era="1950s-1980s",
    signature_quote="Кино — это искусство приблизить лицо. Показать душу через черты.",
    color_signature="Чёрно-белое/скандинавская палитра: белый, серый, чёрный, холодный беж",
    color_temperature="cool",
    color_saturation="muted",
    color_harmony="monochrome",
    accent_color_philosophy="Отсутствие цвета = чистота эмоции",
    light_signature="Северный свет: мягкий, рассеянный, из окон, холодный",
    light_contrast="medium",
    light_temperature="cool",
    shadow_quality="soft",
    light_key="natural",
    lens_preference="Средние фокусы (50mm), крупные планы лиц",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="tight",
    composition_signature="Лицо в центре: максимальная концентрация на эмоции через крупный план",
    symmetry_preference="symmetric",
    depth_layers="shallow",
    negative_space_use="extensive",
    rule_of_thirds="respects",
    mood_signature="Экзистенциальная тоска, молчание, холодное спокойствие",
    atmosphere_density="clear",
    emotional_target="Катарсис через страдание, духовный поиск",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="high",
    detail_philosophy="Лицо как главная текстура: морщины, взгляд, молчание",
    film_stock_signature="Скандинавская плёнка, мягкий контраст",
    grain_use="moderate",
    color_grading="natural",
    scale_preference="intimate",
    set_design="minimal",
    signature_element="Крупные планы лиц в молчании, скандинавский свет",
)

DIRECTORS["феллини"] = DirectorProfile(
    name="Федерико Феллини",
    era="1950s-1990s",
    signature_quote="Реальность — это не то, что ты видишь. Реальность — это то, что ты чувствуешь.",
    color_signature="Яркая, театральная: красный, золотой, пурпурный, пастельные тона",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Избыток цвета как избыток жизни",
    light_signature="Театральный свет: софиты, контровой, цветные гели, эффекты",
    light_contrast="high",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="studio",
    lens_preference="Широкий угол для гротеска, крупные планы",
    focal_length_style="wide",
    camera_movement="dynamic",
    framing_style="extreme",
    composition_signature="Гротескная, перенасыщенная, карнавальная: множество деталей одновременно",
    symmetry_preference="dynamic",
    depth_layers="deep",
    negative_space_use="minimal",
    rule_of_thirds="breaks",
    mood_signature="Карнавал, ностальгия, театральность, избыток жизни",
    atmosphere_density="hazy",
    emotional_target="Избыток, радость, ностальгия, гротеск",
    dynamics="energetic",
    subject_motion="choreographed",
    texture_focus="high",
    detail_philosophy="Чем больше — тем лучше: слои, люди, костюмы, декор",
    film_stock_signature="Яркая итальянская плёнка, тёплые тона, мягкое зерно",
    grain_use="moderate",
    color_grading="stylized",
    scale_preference="epic",
    set_design="theatrical",
    signature_element="Карнавальная процессия, гротескные крупные планы, Via Veneto",
)

DIRECTORS["звягинцев"] = DirectorProfile(
    name="Андрей Звягинцев",
    era="2000s-2020s",
    signature_quote="Тишина — самый громкий звук в кино.",
    color_signature="Холодная северная палитра: сизый, белый, грязно-зелёный, хром",
    color_temperature="cool",
    color_saturation="muted",
    color_harmony="analogous",
    accent_color_philosophy="Цвета природы: ржавчина, плесень, выцветшее небо",
    light_signature="Северный рассеянный свет, пасмурное небо, искусственный свет ламп",
    light_contrast="medium",
    light_temperature="cool",
    shadow_quality="soft",
    light_key="natural",
    lens_preference="Нормальный (50mm), статичные планы, бесстрастное наблюдение",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="classic",
    composition_signature="Пустота как главный герой: много воздуха вокруг человека",
    symmetry_preference="balanced",
    depth_layers="moderate",
    negative_space_use="extensive",
    rule_of_thirds="respects",
    mood_signature="Холодное отчаяние, одиночество в пустоте, безнадёжность",
    atmosphere_density="clear",
    emotional_target="Катарсис через холод, очищение пустотой",
    dynamics="calm",
    subject_motion="minimal",
    texture_focus="high",
    detail_philosophy="Текстура запустения: облупившаяся краска, грязь, холодный бетон",
    film_stock_signature="Современная цифра с холодной цветокоррекцией, teal/orange",
    grain_use="minimal",
    color_grading="stylized",
    scale_preference="epic",
    set_design="realistic",
    signature_element="Пустые пространства, человек маленький в большом пейзаже, пасмурно",
)

DIRECTORS["балабанов"] = DirectorProfile(
    name="Алексей Балабанов",
    era="1990s-2010s",
    signature_quote="Я снимаю правду. Даже если она никому не нравится.",
    color_signature="Грязная, выцветшая, постсоветская: ржавый, грязно-жёлтый, серый",
    color_temperature="warm",
    color_saturation="muted",
    color_harmony="analogous",
    accent_color_philosophy="Цвета упадка: обшарпанные стены, грязные стекла",
    light_signature="Грязный, натуральный свет: лампы дневного света, серое небо, сырость",
    light_contrast="low",
    light_temperature="warm",
    shadow_quality="diffused",
    light_key="natural",
    lens_preference="Ручная камера, зум, натуральная оптика без стилизации",
    focal_length_style="normal",
    camera_movement="handheld",
    framing_style="classic",
    composition_signature="Натуральная, «случайная», без стилизации — жизнь как есть",
    symmetry_preference="balanced",
    depth_layers="moderate",
    negative_space_use="minimal",
    rule_of_thirds="respects",
    mood_signature="Грубая правда, безысходность с юмором, жизнь на грани",
    atmosphere_density="hazy",
    emotional_target="Катарсис через правду, сочувствие к «маленькому человеку»",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="high",
    detail_philosophy="Грязь, быт, неустроенность как визуальный язык",
    film_stock_signature="Дешёвая плёнка/цифра, никакой цветокоррекции",
    grain_use="heavy",
    color_grading="natural",
    scale_preference="intimate",
    set_design="realistic",
    signature_element="Натурализм, жизнь без прикрас, атмосфера постсоветского быта",
)


# ─── 🎨 ДИЗАЙНЕРЫ ─────────────────────────

DESIGNERS = {}

DESIGNERS["harari"] = DirectorProfile(
    name="Юваль Харари (эстетика информации)",
    role="🎨 Дизайнер-визионер",
    era="contemporary",
    signature_quote="Красота — это функция. Самая эффективная — привлекает внимание, удерживает, конвертирует.",
    color_signature="Чистые, насыщенные природные тона с высокой степенью разборчивости",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Один-два контрастных акцента: 90/10 правило для читаемости",
    light_signature="Равномерный, чистый свет: студийный или обработанный естественный",
    light_contrast="medium",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="studio",
    lens_preference="85-105mm для товаров, 50mm для контекста",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="tight",
    composition_signature="Чистая, функциональная: объект доминирует, ничего лишнего",
    symmetry_preference="symmetric",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Доверие, качество, премиальная простота",
    atmosphere_density="clear",
    emotional_target="Доверие, желание обладать, ощущение ценности",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="high",
    detail_philosophy="Каждая текстура говорит о качестве: материал должен быть «осязаемым» на фото",
    film_stock_signature="Чистый цифровой образ с лёгкой теплотой",
    grain_use="none",
    color_grading="natural",
    scale_preference="intimate",
    set_design="minimal",
    signature_element="Объект в центре, чистая эстетика, «дышащий» фон",
)

DESIGNERS["newson"] = DirectorProfile(
    name="Марк Ньюсон",
    role="🎨 Промышленный дизайнер",
    era="contemporary",
    signature_quote="Дизайн — это не то, как вещь выглядит. Дизайн — это то, как вещь работает для человека.",
    color_signature="Премиум-нейтралы: алюминий, белый, чёрный, кремовый, хром",
    color_temperature="cool",
    color_saturation="muted",
    color_harmony="monochrome",
    accent_color_philosophy="Минимум: только один премиальный акцент (золото, медь)",
    light_signature="Студийный свет с акцентом на отражения и блики — показать форму",
    light_contrast="high",
    light_temperature="cool",
    shadow_quality="hard",
    light_key="studio",
    lens_preference="50-85mm, акцент на чистую геометрию",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="tight",
    composition_signature="Чистая геометрия, золотое сечение, объект как скульптура",
    symmetry_preference="symmetric",
    depth_layers="shallow",
    negative_space_use="extensive",
    rule_of_thirds="respects",
    mood_signature="Премиум, инновация, технологическая элегантность",
    atmosphere_density="clear",
    emotional_target="Восхищение формой, желание прикоснуться",
    dynamics="calm",
    subject_motion="minimal",
    texture_focus="high",
    detail_philosophy="Поверхность говорит всё: отражения, градиенты, стыки материалов",
    film_stock_signature="Цифровой с высоким динамическим диапазоном",
    grain_use="none",
    color_grading="stylized",
    scale_preference="intimate",
    set_design="minimal",
    signature_element="Объект на белом/нейтральном фоне, драматичные отражения",
)

DESIGNERS["abrams"] = DirectorProfile(
    name="Чип Кидд / Chip Kidd (обложки)",
    role="🎨 Графический дизайнер",
    era="contemporary",
    signature_quote="Дизайн — это визуальный интеллект. Лишнее убирай, суть оставляй.",
    color_signature="Смелые контрастные пары: чёрный/жёлтый, красный/белый, синий/оранж",
    color_temperature="mixed",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Максимум один-два цвета для максимальной запоминаемости",
    light_signature="Графичный, контрастный свет без полутонов",
    light_contrast="high",
    light_temperature="mixed",
    shadow_quality="hard",
    light_key="studio",
    lens_preference="Чёткий, графичный: 85mm для предметов, широкий для контекста",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="tight",
    composition_signature="Силуэт + контраст + минимум: информация через пустоту",
    symmetry_preference="symmetric",
    depth_layers="shallow",
    negative_space_use="extensive",
    rule_of_thirds="respects",
    mood_signature="Интеллектуальная смелость, провокация через простоту",
    atmosphere_density="clear",
    emotional_target="Запоминание, любопытство, желание узнать больше",
    dynamics="calm",
    subject_motion="minimal",
    texture_focus="moderate",
    detail_philosophy="Одна деталь вместо ста: гипербола через изоляцию",
    film_stock_signature="Чистый цифровой, графичный, плакатный",
    grain_use="none",
    color_grading="stylized",
    scale_preference="intimate",
    set_design="minimal",
    signature_element="Минималистичная композиция, плакатная эстетика, пустота говорит",
)

DESIGNERS["wes"] = DirectorProfile(
    name="Уэс Андерсон (визуальный дизайн)",
    role="🎨 Кино-дизайнер",
    era="contemporary",
    signature_quote="Всё должно быть на своём месте. Идеально. Симметрично. Прекрасно.",
    color_signature="Пастельная палитра: мятный, розовый, жёлтый, голубой, терракотовый",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="analogous",
    accent_color_philosophy="Один яркий акцент на пастельном фоне",
    light_signature="Равномерный, почти студийный свет: никаких резких теней",
    light_contrast="low",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="studio",
    lens_preference="Широкий угол для симметрии, 40mm для планов",
    focal_length_style="wide",
    camera_movement="static",
    framing_style="classic",
    composition_signature="Идеальная симметрия, центрирование, плоскостная композиция",
    symmetry_preference="symmetric",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="breaks",
    mood_signature="Ностальгическая идиллия, стилизованная реальность, уют",
    atmosphere_density="clear",
    emotional_target="Уют, ностальгия, радость порядка",
    dynamics="calm",
    subject_motion="choreographed",
    texture_focus="moderate",
    detail_philosophy="Каждая деталь — часть пазла, ничего случайного",
    film_stock_signature="Kodak, пастельная цветокоррекция",
    grain_use="minimal",
    color_grading="stylized",
    scale_preference="intimate",
    set_design="stylized",
    signature_element="Идеальная симметрия, пастельные тона, центрированный кадр",
)


# ─── 📈 МАРКЕТОЛОГИ ───────────────────────

MARKETERS = {}

MARKETERS["ogilvy"] = DirectorProfile(
    name="Дэвид Огилви",
    role="📈 Рекламист и маркетолог",
    era="1960s-1990s",
    signature_quote="Продавай не товар. Продавай то, что товар делает для человека.",
    color_signature="Классическая продающая палитра: синий (доверие), красный (действие), белый",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Смелые акценты для CTA и внимания: красный/оранжевый на нейтральном",
    light_signature="Чёткий, разборчивый свет: товар должен быть виден идеально",
    light_contrast="medium",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="studio",
    lens_preference="85mm — естественная перспектива, товар читаем без искажений",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="classic",
    composition_signature="Правило третей: товар в точке фокуса, путь взгляда от заголовка к продукту",
    symmetry_preference="balanced",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Доверие, качество, проверенное временем",
    atmosphere_density="clear",
    emotional_target="Доверие, уверенность в выборе, комфорт покупки",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="high",
    detail_philosophy="Товар должен быть визуально «осязаем»: текстуры убеждают лучше слов",
    film_stock_signature="Kodak, тёплый, «честный» цвет",
    grain_use="minimal",
    color_grading="natural",
    scale_preference="intimate",
    set_design="realistic",
    signature_element="Big Idea: один сильный визуальный аргумент на весь кадр",
)

MARKETERS["godin"] = DirectorProfile(
    name="Сет Годин",
    role="📈 Маркетолог и автор",
    era="2000s-2020s",
    signature_quote="People don't buy. They join. Создай что-то, к чему хочется принадлежать.",
    color_signature="Смелая, неожиданная палитра: «фиолетовая корова» — выделяйся",
    color_temperature="mixed",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Неожиданный акцент на том, что отличает. Запоминаемость через уникальность.",
    light_signature="Эмоциональный свет: сторителлинг через тени и свет",
    light_contrast="medium",
    light_temperature="mixed",
    shadow_quality="soft",
    light_key="mixed",
    lens_preference="50mm — интимный, человеческий взгляд",
    focal_length_style="normal",
    camera_movement="handheld",
    framing_style="tight",
    composition_signature="Несовершенство как аутентичность: не через симметрию, а через идею",
    symmetry_preference="dynamic",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="breaks",
    mood_signature="Аутентичность, смелость, человечность",
    atmosphere_density="clear",
    emotional_target="Принадлежность, восхищение смелостью, желание присоединиться",
    dynamics="energetic",
    subject_motion="natural",
    texture_focus="moderate",
    detail_philosophy="Детали, которые рассказывают историю: не «что», а «почему»",
    film_stock_signature="Lifestyle: «как есть», честная эстетика Instagram/бесплёночная",
    grain_use="moderate",
    color_grading="natural",
    scale_preference="intimate",
    set_design="realistic",
    signature_element="Purple Cow: необычный элемент, который выделяет из толпы",
)

MARKETERS["halbert"] = DirectorProfile(
    name="Гэри Хэлберт",
    role="📈 Копирайтер и direct-маркетолог",
    era="1980s-2000s",
    signature_quote="Люди не покупают вещи. Они покупают ощущение, которое эти вещи дадут.",
    color_signature="Ультра-контрастная продающая: жёлтый/чёрный для внимания, красный/белый для действия",
    color_temperature="warm",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Яркие акценты на точках действия и выгоде",
    light_signature="Максимальная читаемость: всё освещено, ничего не скрыто",
    light_contrast="high",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="studio",
    lens_preference="85мм — портретный/продуктовый, товар = герой",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="tight",
    composition_signature="Агрессивный фокус на выгоде: товар/результат в центре, ничто не отвлекает",
    symmetry_preference="symmetric",
    depth_layers="shallow",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Срочность, необходимость, «бери сейчас или потеряешь»",
    atmosphere_density="clear",
    emotional_target="Страх упустить выгоду, жадность, желание решить проблему немедленно",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="high",
    detail_philosophy="Каждая деталь работает на продажу: нет декоративных элементов",
    film_stock_signature="Чистый, гипер-реалистичный цифровой образ",
    grain_use="none",
    color_grading="natural",
    scale_preference="intimate",
    set_design="minimal",
    signature_element="Преимущество в заголовке/визуале: «до/после», «результат»",
)

MARKETERS["sutherland"] = DirectorProfile(
    name="Рори Сазерленд",
    role="📈 Специалист по поведенческой экономике",
    era="2010s-2020s",
    signature_quote="Продавай не качество. Продавай восприятие. Восприятие — это реальность покупателя.",
    color_signature="Цвет как якорь восприятия: неожиданные сочетания, которые запоминаются",
    color_temperature="mixed",
    color_saturation="vibrant",
    color_harmony="complementary",
    accent_color_philosophy="Неожиданный цветовой акцент как якорь памяти",
    light_signature="«Ощущаемый» свет — свет создаёт настроение, которое покупатель проецирует на товар",
    light_contrast="medium",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="mixed",
    lens_preference="50-85mm, человеческий масштаб",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="classic",
    composition_signature="Парадоксальная: привычное показать неожиданно. Якорение через контекст.",
    symmetry_preference="balanced",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="breaks",
    mood_signature="Интрига, неожиданность, «почему я раньше этого не замечал?»",
    atmosphere_density="clear",
    emotional_target="Инсайт, изменивший восприятие, «как я раньше этого не видел?»",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="moderate",
    detail_philosophy="Контекст меняет восприятие: фон и окружение — часть сообщения",
    film_stock_signature="Эстетика, повышающая воспринимаемую ценность",
    grain_use="minimal",
    color_grading="stylized",
    scale_preference="intimate",
    set_design="realistic",
    signature_element="Фрейминг: измени контекст — измени ценность товара в глазах покупателя",
)

MARKETERS["handley"] = DirectorProfile(
    name="Энн Хэндли",
    role="📈 Контент-маркетолог",
    era="2010s-2020s",
    signature_quote="Make it useful. Make it clear. Make it matter.",
    color_signature="Чистая, доступная палитра: белый + один брендовый цвет, акценты на иконках",
    color_temperature="warm",
    color_saturation="moderate",
    color_harmony="analogous",
    accent_color_philosophy="Цвет для иерархии: важное — цветное, остальное — нейтральное",
    light_signature="Мягкий, ровный свет — никаких отвлекающих теней",
    light_contrast="low",
    light_temperature="warm",
    shadow_quality="soft",
    light_key="studio",
    lens_preference="50mm — «как видит человек»",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="classic",
    composition_signature="Понятная иерархия: взгляд чётко следует от главного к деталям",
    symmetry_preference="balanced",
    depth_layers="moderate",
    negative_space_use="moderate",
    rule_of_thirds="respects",
    mood_signature="Полезность, ясность, доступность",
    atmosphere_density="clear",
    emotional_target="Понимание, доверие, «это для меня»",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="moderate",
    detail_philosophy="Минимум деталей для ясности. Микро-текстуры — для доверия.",
    film_stock_signature="Чистый, современный цифровой образ",
    grain_use="none",
    color_grading="natural",
    scale_preference="intimate",
    set_design="minimal",
    signature_element="Понятная структура: взгляд движется по чёткой иерархии информации",
)

MARKETERS["sinek"] = DirectorProfile(
    name="Саймон Синек",
    role="📈 Стратег брендов",
    era="2010s-2020s",
    signature_quote="People don't buy what you do, they buy why you do it.",
    color_signature="Минималистичная, фокусная: чёрный, белый, один акцентный цвет",
    color_temperature="cool",
    color_saturation="muted",
    color_harmony="monochrome",
    accent_color_philosophy="Цвет как символ смысла: акцент не на товаре, а на идее",
    light_signature="Свет как метафора: контраст между смыслами через свет и тень",
    light_contrast="high",
    light_temperature="cool",
    shadow_quality="hard",
    light_key="dramatic",
    lens_preference="50mm — человеческий масштаб, 85mm — портрет идеи",
    focal_length_style="normal",
    camera_movement="static",
    framing_style="tight",
    composition_signature="Крупный план смысла: не товар, а результат/изменение в жизни",
    symmetry_preference="symmetric",
    depth_layers="moderate",
    negative_space_use="extensive",
    rule_of_thirds="respects",
    mood_signature="Цель, смысл, вдохновение, трансформация",
    atmosphere_density="clear",
    emotional_target="Вдохновение, желание быть частью большего, лояльность",
    dynamics="calm",
    subject_motion="natural",
    texture_focus="moderate",
    detail_philosophy="Детали не о товаре — детали о результате для человека",
    film_stock_signature="Чистый, «честный» образ без излишней обработки",
    grain_use="minimal",
    color_grading="natural",
    scale_preference="intimate",
    set_design="minimal",
    signature_element="Start with Why: визуализация результата/трансформации, а не товара",
)


# ─── СБОРНЫЙ СЛОВАРЬ ──────────────────────

ALL_PROFILES: dict[str, DirectorProfile] = {}
ALL_PROFILES.update(DIRECTORS)
ALL_PROFILES.update(DESIGNERS)
ALL_PROFILES.update(MARKETERS)


def get_profile(name: str) -> Optional[DirectorProfile]:
    """Получить профиль по имени (регистронезависимо)."""
    name_lower = name.lower().strip()
    for key, profile in ALL_PROFILES.items():
        if key == name_lower or profile.name.lower() == name_lower:
            return profile
    return None


def list_profiles_by_role() -> dict:
    """Список профилей, сгруппированных по ролям."""
    return {
        "🎬 Кинорежиссёры": [(k, v.name) for k, v in DIRECTORS.items()],
        "🎨 Дизайнеры": [(k, v.name) for k, v in DESIGNERS.items()],
        "📈 Маркетологи": [(k, v.name) for k, v in MARKETERS.items()],
    }


def auto_select_profile(product_category: str, product_type: str = "") -> str:
    """Автоматически подобрать профиль по категории товара."""
    # Для коммерческих товаров — маркетологи ближе к цели
    if product_category in ("одежда", "обувь", "косметика"):
        return "harari"  # продуктовый дизайн
    elif product_category in ("еда", "уход"):
        return "ogilvy"  # прямая продажа
    elif product_category in ("электроника", "декор"):
        return "newson"  # премиум-дизайн
    else:
        return "harari"