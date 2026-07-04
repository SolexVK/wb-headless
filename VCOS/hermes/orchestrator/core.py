"""VCOS — Orchestrator v4

Когнитивный цикл на новой архитектуре:
  Registry + ProjectModel + SemanticGraphAdapter v2

Принципы (CM-001, CA-001, CP-001):
  - Registry — единственное хранилище объектов
  - ProjectModel — только ID-ссылки
  - GraphAdapter пишет в Registry, обновляет ProjectModel
  - Каждая мутация создаёт новое состояние
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from typing import Any, Dict, Optional
from dataclasses import dataclass, field
from datetime import datetime

from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel, ProjectIdentity
from hermes.kernel.graph_adapter import SemanticGraphAdapter
from hermes.kernel.proposal import Proposal, ProposalSource
from hermes.transformers.base import TransformResult
from hermes.design.visual_reasoner import VisualReasoner
from hermes.design.confidence import ConfidenceEvaluator
from hermes.agents.dialogue_agent import DialogueAgent
from hermes.renderers.prompt_exporter import (
    PromptExporter, extract_prompt_data, SUPPORTED_MODELS
)
from hermes.kernel.validator import Validator
from hermes.kernel.decision_maker import DecisionMaker
from hermes.kernel.proposal import Proposal, ProposalSource
from hermes.kernel.core import Node, NodeType, LifecycleState, EXTRA_TYPES
from hermes.knowledge.registry import KnowledgeRegistry
from hermes.knowledge.providers.photography import (
    PhotographyProvider, LightingKnowledgeProvider
)
from hermes.sde.scene_discovery import SceneDiscoveryEngine
from hermes.domain_packs import DomainPackRegistry, PhotographyPack, FilmPack, AdvertisingPack

# ═══════════════════════════════════════════
# Transformer Chain Integration (CP-001 §4)
# ═══════════════════════════════════════════

from hermes.transformers.orchestrator import TransformerOrchestrator
from hermes.transformers.dialogue_transformer import DialogueTransformer
from hermes.transformers.llm_transformer import LLMTransformer
from hermes.transformers.knowledge_transformer import KnowledgeTransformer
from hermes.transformers.interview_transformer import InterviewTransformer
from hermes.transformers.design_transformer import DesignTransformer
from hermes.transformers.compile_transformer import CompileTransformer
from hermes.transformers.category_transformer import CategoryTransformer
from hermes.transformers.profile_transformer import ProfileTransformer
from hermes.transformers.clarify_transformer import ClarifyTransformer


# ═══════════════════════════════════════════
# Computational Theory: 2 типа фаз (doc 168)
# ═══════════════════════════════════════════

# Когнитивные фазы — меняют Understanding → Understanding
COGNITIVE_PHASES = [
    ("category",   "🏷 Категория товара"),       # Observe — получение данных
    ("product",    "🧥 Товар"),                   # Interpret — интерпретация
    ("model_scene","👤 Модель + окружение"),       # Reason — рассуждение
    ("reference",  "🖼 Референс (опционально)"),  # Reason — дополнительный анализ
    ("constraints","🚫 Ограничения"),             # Reason — задание рамок
    ("profile",    "🎭 Выбор профиля"),            # Reason — определение подхода
    ("direction",  "🎬 Режиссура"),               # Design — проектное решение
    ("creative_strategy", "💡 Творческий замысел"),# Design — творческое решение
    ("inference",  "🤖 Inference Engine"),        # Design — вывод LLM
    ("control",    "✅ Финальный контроль"),       # Validate — проверка
]

# Компиляционные фазы — не меняют понимание, только экспортируют
COMPILATION_PHASES = [
    ("export",     "🎯 Выбор модели"),             # Compile/Export
]

# Общий список для обратной совместимости
PHASES = COGNITIVE_PHASES + COMPILATION_PHASES


@dataclass
class OrchestratorState:
    session_id: str = ""
    started_at: str = ""
    status: str = "idle"
    last_result: dict = field(default_factory=dict)


class Orchestrator:
    """VCOS Orchestrator v4 — когнитивный цикл на Registry + ProjectModel.

    Команда:
      DialogueAgent     — задаёт вопросы, парсит ответы, уточняет
      VisualReasoner    — применяет профили, запускает Inference
      ConfidenceEvaluator — оценивает уверенность
      SemanticGraphAdapter v2 — пишет в Registry, обновляет ProjectModel
      PromptExporter    — финальный экспорт
    """

    def __init__(self):
        # ─── Новая архитектура: Registry + ProjectModel ──────
        self.registry = Registry()
        self.project = ProjectModel(
            identity=ProjectIdentity(
                id=f"vcos_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                version=1,
            )
        )
        self.graph = SemanticGraphAdapter(self.registry, self.project)

        # ─── Остальные компоненты ────────────────────────────
        self.dialogue = DialogueAgent()
        self.reasoner = VisualReasoner(self.registry, self.project)
        self.evaluator = ConfidenceEvaluator()
        self.decider = DecisionMaker(self.registry, self.project, self.graph.logger)
        self.knowledge = KnowledgeRegistry()
        self.knowledge.register(PhotographyProvider())
        self.knowledge.register(LightingKnowledgeProvider())
        self.sde = SceneDiscoveryEngine(use_llm=True)
        self.exporter = PromptExporter()

        # model_target для артефактов (SemanticGraph не имеет setter'а)
        self._model_target = ""

        # ─── Domain Pack Registry: все доступные паки ─────────
        from hermes.domain_packs import (
            InfographicPack, YouTubePack, FashionPack,
            ProductPack, TypographyEditorialPack, AnimationPack,
        )
        self.domain_packs = DomainPackRegistry()
        for pack_cls in (PhotographyPack, FilmPack, AdvertisingPack,
                         InfographicPack, YouTubePack, FashionPack,
                         ProductPack, TypographyEditorialPack, AnimationPack):
            self.domain_packs.register(pack_cls())
        self._active_domain_pack = None

        # ─── Transformer Chain (CP-001 §4) — 10 трансформеров ──
        self._transformer_orch = TransformerOrchestrator()
        self._transformer_orch.register_transformers(
            DialogueTransformer(),
            InterviewTransformer(),
            CategoryTransformer(),
            DesignTransformer(),
            ProfileTransformer(),
            LLMTransformer(),
            KnowledgeTransformer(),
            ClarifyTransformer(),
            CompileTransformer(),
        )
        # Явная маршрутизация фаза → трансформер.
        # Без неё первый зарегистрированный can_handle-претендент (Dialogue)
        # затеняет Category/Profile/Clarify.
        self._transformer_orch.set_routes({
            "category": "category",
            "profile": "profile",
            "interview": "dialogue",
            "inference": "clarify",   # фаза 4: уточнение/выбор модели
            "clarify": "clarify",
        })

        self.state = OrchestratorState()

        self._phase = 0
        self._clarify_count = 0
        self._current_category = ""
        self._current_profile = None
        self._violations = []

        # ─── Cognitive Loop (CompTheory §2) ───────────────────
        self._lock_intent = False
        self._cognitive_gap = []

        # I-009: Intent Integrity — записываем залоченный Intent
        self._locked_intent_value = None
        self._locked_intent_source = None

    def start_new_session(self, category: Optional[str] = None) -> dict:
        """Начать новую сессию."""
        self.state.session_id = self.project.identity.id
        self.state.started_at = datetime.now().isoformat()
        self.state.status = "active"
        self._phase = 1 if category else 0

        # Source — через Proposal-Decide
        self._apply_proposal({
            "block": "source", "field": "content", "value": "Начало сессии",
            "source": "system", "confidence": 1.0,
        })

        # Intent — через Proposal-Decide с защитой _lock_intent
        if not self._lock_intent:
            intent_value = (f"Создание промпта: {category}" if category
                            else "Создание промпта")
            self._locked_intent_value = intent_value
            self._locked_intent_source = "system"
            self._apply_proposal({
                "block": "intent", "field": "description",
                "value": intent_value,
                "source": "system", "confidence": 1.0,
            })
            self._lock_intent = True

        if category:
            self._current_category = category
            self.project = self.project.with_domain([category])
            self._apply_proposal({
                "block": "goal", "field": "description",
                "value": f"Промпт для {category}",
                "source": "system", "confidence": 1.0,
            })

            # Подобрать Domain Pack
            pack = self.domain_packs.get_for_domain(category)
            if pack:
                self._active_domain_pack = pack
                self._apply_proposal({
                    "block": "intent", "field": "domain_pack",
                    "value": pack.name, "source": "system",
                    "confidence": 1.0,
                    "rationale": f"Автоподбор Domain Pack: {category}",
                })

            text = self._sde_question(["intent"])
        else:
            text = self._sde_question(["intent"])  # category

        self.state.last_result = {"type": "question", "text": text}
        return self.state.last_result

    def _run_transformer_phase(self, phase_name: str, answer: str = "",
                                extra_config: Optional[Dict[str, Any]] = None) -> Optional[TransformResult]:
        """Запустить фазу через трансформер.

        Маршрутизирует фазу к соответствующему трансформеру.
        Если трансформер не найден — возвращает None (использовать fallback).

        Args:
            phase_name: имя фазы
            answer: ответ пользователя
            extra_config: дополнительная конфигурация

        Returns:
            TransformResult от трансформера, или None если нет подходящего
        """
        result = self._transformer_orch.run_single(
            self.project, self.registry,
            phase=phase_name,
            config={
                "phase": phase_name,
                "user_input": answer,
                **(extra_config or {}),
            },
        )
        return result

    # ─── Карта фаз: номер → имя трансформера (class constants) ──
    PHASE_MAP = {
        0: "category",
        1: "interview",
        2: "interview",
        -2: "interview",
        -3: "constraints",
        -1: "profile",
        3: "interview",
        31: "interview",
        4: "inference",
        5: "clarify",
        6: "export",
    }

    PHASE_NEXT = {
        0: 1, 1: 2, 2: -2, -2: -3, -3: -1, -1: 3, 3: 31, 31: 4, 4: 5, 5: 6, 6: None,
    }

    PHASE_BLOCK = {
        1: "product", 2: "model_scene", -2: "reference", 3: "direction", 31: "creative_strategy",
    }

    PHASE_SDE_QUESTIONS = {
        0: ["intent"],
        1: ["model_scene", "environment", "character"],
        -2: ["style", "composition"],
        -3: ["composition", "camera", "lighting", "color", "style"],
        -1: ["direction", "composition", "camera", "lighting", "color", "style"],
        3: [], 31: [], 4: [],
    }

    def submit_answer(self, answer: str) -> dict:
        """Отправить ответ. Единый диспетчер через Transformer Chain.

        CompTheory §2: Observe→Evaluate→Decide→Act→Record — в run_single()
        §7.1: Orchestrator ТОЛЬКО диспетчеризирует
        §10 HR#3: Orchestrator не принимает визуальных решений
        §10 HR#6: Все через Semantic Graph
        """
        phase = self._phase
        phase_name = self.PHASE_MAP.get(phase, "")

        if not phase_name:
            return {"type": "error", "text": f"Неизвестная фаза: {phase}"}

        # Специальные фазы (не через трансформеры)
        if phase == -3:
            return self._handle_constraints_phase(answer)

        # Фаза 6 (export) — через _export оркестратора, не через трансформеры
        if phase == 6:
            return self._export(answer)

        # Фазы через трансформеры
        block = self.PHASE_BLOCK.get(phase, "")
        config = {
            "phase": phase_name,
            "user_input": answer,
            "block": block,
        }

        # Запустить трансформер (Observe→Evaluate→Decide→Act→Record внутри)
        result = self._transformer_orch.run_single(
            self.project, self.registry,
            phase=phase_name,
            config=config,
        )

        # Применить proposals (единая точка мутации графа — I-004)
        for proposal in result.proposals:
            self._apply_proposal(proposal)

        # SSOT: ProjectModel живёт в адаптере (record_* ребайндит копию).
        # Трансформерный SemanticGraph-обёртку не подменяем в self.project —
        # его данные приходят через proposals и ключи log ниже.
        self.project = self.graph.project

        # Обновить состояние
        if result.log.get("category"):
            cat = result.log["category"]
            self._current_category = cat
            self.graph.project = self.graph.project.with_domain([cat])
            self.project = self.graph.project
            pack = self.domain_packs.get_for_domain(cat)
            if pack:
                self._active_domain_pack = pack
        if result.log.get("domain_pack") and self._active_domain_pack is None:
            self._active_domain_pack = self.domain_packs.get(
                result.log["domain_pack"])
        if result.log.get("profile_name"):
            profile_name = result.log["profile_name"]
            self._current_profile = self._resolve_profile(profile_name)
            self.graph.project = self.graph.project.with_profile(profile_name)
            self.project = self.graph.project

        # Определить следующую фазу (число или имя фазы от трансформера)
        raw_next = result.log.get("next_phase")
        if raw_next is None:
            next_phase = self.PHASE_NEXT.get(phase, phase + 1)
        elif isinstance(raw_next, str) and not raw_next.lstrip("-").isdigit():
            name_to_phase = {"inference": 4, "clarify": 5, "export": 6}
            next_phase = name_to_phase.get(
                raw_next, self.PHASE_NEXT.get(phase, phase + 1))
        else:
            next_phase = int(raw_next)

        # Сформировать вопрос
        if result.log.get("error"):
            question = result.log.get("question", f"❌ {result.log['error']}")
            self.state.last_result = {"type": "question", "text": question}
            return self.state.last_result

        # Пользователь выбрал модель — сразу компилируем артефакт
        if result.log.get("model_selected") and next_phase == 6:
            self._phase = 6
            return self._export(result.log["model_selected"])

        if result.artifacts and phase == 6:
            # Экспорт — готово
            prompt = result.artifacts[0].get("content", "")
            self.state.last_result = {
                "type": "done",
                "text": "✅ **Готово!**",
                "prompt": prompt,
            }
            self._phase = 0 if next_phase is None else next_phase
            return self.state.last_result

        # Перейти на следующую фазу
        self._phase = next_phase if next_phase is not None else 0

        # Если у следующей фазы есть SDE-вопрос — сгенерировать
        sde_blocks = self.PHASE_SDE_QUESTIONS.get(self._phase, [])
        if sde_blocks:
            text = self._sde_question(sde_blocks)
        else:
            text = result.log.get("question", "Продолжаем?")

        self.state.last_result = {"type": "question", "text": text}
        return self.state.last_result

    def _handle_constraints_phase(self, answer: str) -> dict:
        """Обработка ограничений (фаза -3). Специфичная парсинговая логика."""
        skip = answer.lower().strip() in ["нет", "не", "no", "skip", "-", ""]
        if skip and len(answer) < 10:
            self._phase = -1
            text = self._sde_question(["composition", "camera", "lighting", "color", "style"])
            self.state.last_result = {"type": "question", "text": text}
            return self.state.last_result

        import re
        must_have = re.findall(
            r'(?:нужно|обязательно|должно|только)\s+(.+?)(?:\.|,|$)',
            answer.lower(), re.IGNORECASE)
        must_not = re.findall(
            r'(?:без|не должно|нельзя|кроме)\s+(.+?)(?:\.|,|$)',
            answer.lower(), re.IGNORECASE)

        if must_have:
            for m in must_have:
                self._apply_proposal({
                    "block": "constraint", "field": "must_have",
                    "value": m.strip(), "source": "user", "confidence": 1.0,
                })
        if must_not:
            for m in must_not:
                self._apply_proposal({
                    "block": "constraint", "field": "must_not",
                    "value": m.strip(), "source": "user", "confidence": 1.0,
                })
        if not must_have and not must_not:
            self._apply_proposal({
                "block": "constraint", "field": "general",
                "value": answer.strip(), "source": "user", "confidence": 1.0,
            })

        # Domain Pack Constraints
        if self._active_domain_pack:
            context = {
                "platform": self._current_category,
                "product_type": self._current_category,
            }
            pack_constraints = self._active_domain_pack.get_constraints(context)
            for c in pack_constraints:
                self._apply_proposal({
                    "block": "constraint", "field": c.constraint_type,
                    "value": c.description, "source": "domain_pack",
                    "confidence": 0.9,
                })

        self._phase = -1
        text = self._sde_question(["composition", "camera", "lighting", "color", "style"])
        self.state.last_result = {"type": "question", "text": text}
        return self.state.last_result

    # ═══════════════════════════════════════════
    # Cognitive Loop (Computational Theory §2)

    def observe(self, phase: str = "") -> list:
        """Шаг 1: Observe — читает граф, определяет Cognitive Gap.

        Анализирует текущее состояние графа и возвращает список
        неизвестных или неуверенных значений для данной фазы.

        Computational Theory §2.1:
          Вход: Semantic Graph
          Выход: Cognitive Gap — множество неизвестных или неуверенных значений.
        """
        gap = []
        blocks_map = {
            "category": ["category", "product_type"],
            "product": ["type", "color", "material", "brand"],
            "model_scene": ["model", "environment", "character"],
            "reference": ["reference", "style_reference"],
            "constraints": ["must_have", "must_not", "aspect_ratio", "format"],
            "profile": ["profile", "director", "mood"],
            "direction": ["composition", "camera", "lighting", "color", "style", "mood", "atmosphere"],
            "creative_strategy": ["core_idea", "approach", "target_emotion", "visual_metaphor"],
            "inference": ["lens", "lighting_setup", "color_palette", "composition_type"],
            "control": ["consistency", "completeness", "confidence_check"],
        }
        fields = blocks_map.get(phase, [])

        for field in fields:
            found = False
            for d in self.graph.logger.decisions:
                if d.field == field:
                    found = True
                    if d.confidence < 0.4:
                        gap.append({"field": field, "reason": "low_confidence", "conf": d.confidence})
                    break
            if not found:
                gap.append({"field": field, "reason": "missing"})

        self._cognitive_gap = gap
        return gap

    def evaluate(self, gap: list) -> list:
        """Шаг 2: Evaluate — оценивает Cognitive Gap, приоритизирует.

        Computational Theory §2.2:
          Вход: Cognitive Gap + Knowledge
          Выход: Prioritised Actions — список действий с приоритетами.
        """
        if not gap:
            return []

        actions = []
        for item in gap:
            action = {
                "field": item["field"],
                "priority": "high" if item.get("reason") == "missing" else "medium",
                "action": "ask_user" if item.get("reason") == "missing" else "clarify",
                "rationale": f"{item['field']}: {item.get('reason', 'unknown')}",
            }
            actions.append(action)

        actions.sort(key=lambda a: 0 if a["priority"] == "high" else 1)
        return actions

    def decide(self, actions: list) -> Optional[dict]:
        """Шаг 3: Decide — выбирает одно действие, записывает Decision.

        Computational Theory §2.3:
          Вход: Prioritised Actions
          Выход: Decision (запись в граф).
        """
        if not actions:
            return None

        chosen = actions[0]
        # Записать Decision
        self._apply_proposal({
            "block": "cognitive_loop",
            "field": chosen["field"],
            "value": chosen["action"],
            "source": "system",
            "confidence": 0.8,
            "rationale": chosen["rationale"],
        })
        return chosen

    def act(self, decision: dict, answer: str = "", phase: str = "") -> dict:
        """Шаг 4: Act — выполняет действие.

        Computational Theory §2.4:
          Вход: Decision
          Выход: Изменение Semantic Graph (через transformer или вопрос).
        """
        if not decision:
            return {"type": "done", "text": "Все поля известны."}

        action = decision.get("action", "ask_user")
        if action == "ask_user":
            question = self._sde_question([decision.get("field", phase)])
            return {"type": "question", "text": question}
        elif action == "clarify":
            return {"type": "question",
                    "text": f"❓ Уточни {decision.get('field', '')}: не хватает данных."}
        return {"type": "done", "text": ""}

    def record(self, decision: dict, result: dict) -> None:
        """Шаг 5: Record — фиксирует результат в графе.

        Computational Theory §2.5:
          Результат действия фиксируется в Semantic Graph.
        """
        if result.get("type") == "question":
            return  # Вопрос — ещё не ответ, не записываем

        if decision:
            self._apply_proposal({
                "block": "cognitive_loop",
                "field": f"{decision.get('field', '')}",
                "value": result.get("text", ""),
                "source": "system",
                "confidence": 0.9,
                "rationale": "Record cognitive cycle step",
            })

    # ─── Внутренние методы ──────────────────────────────────

    def _prepare_export_data(self, target: str):
        """Собрать данные для экспорта: граф + знания + подсказки пака.

        Порядок приоритета: решения из графа (пользователь/профиль) >
        факты Knowledge Provider > render hints Domain Pack.
        Факты знаний записываются в граф решениями source="knowledge".
        """
        project_data = self.graph.project_data()
        project_data = self._map_export_fields(project_data)

        # Knowledge Provider: заполняем пробелы фактами по доменам пака
        knowledge_domains = []
        if self._active_domain_pack:
            knowledge_domains = list(
                getattr(self._active_domain_pack, "requires_knowledge", []))
        if self._current_category and not knowledge_domains:
            knowledge_domains = [self._current_category]
        for kd in knowledge_domains:
            try:
                kres = self.knowledge.query(
                    domain=kd,
                    context={"mood": project_data.get("mood", "")},
                )
            except Exception:
                continue
            for f in kres.facts:
                fld = f.vsl_field
                if fld and not project_data.get(fld):
                    self._apply_proposal({
                        "block": f.block, "field": fld,
                        "value": str(f.value), "source": "knowledge",
                        "confidence": f.confidence,
                        "rationale": f"Knowledge Provider: {kd}",
                    })
                    project_data[fld] = str(f.value)

        # Domain Pack render hints — только незанятые ключи
        if self._active_domain_pack:
            hint_key_map = {"ar": "aspect_ratio"}
            hints = self._active_domain_pack.get_render_hints(target) or {}
            for k, v in hints.items():
                if isinstance(v, (str, int, float)):
                    project_data.setdefault(hint_key_map.get(k, k), str(v))

        # Reference
        ref = None
        for d in self.graph.logger.decisions:
            if d.block == "reference":
                from hermes.renderers.prompt_exporter import ReferenceSlot
                ref = ReferenceSlot(enabled=True, description=d.value)
                break

        return project_data, ref

    def _map_export_fields(self, data: dict) -> dict:
        """Мост между полями решений и ключами PromptExporter.

        Интервью пишет решения полями type/color/material/model/...,
        а build_full_story читает intent/character/environment/... —
        без этого маппинга данные пользователя не попадают в промпт.
        """
        mapped = dict(data)

        # Продукт → Concept: intent дополняется описанием товара
        product_bits = [mapped.get(k, "") for k in
                        ("type", "color", "material", "brand", "fit")]
        product = ", ".join(p for p in product_bits if p)
        if product:
            intent = mapped.get("intent", "")
            mapped["intent"] = f"{intent}: {product}" if intent else product

        # Модель/персонаж → Character (объединяем, не затираем)
        character_bits = [mapped.get(k, "") for k in
                          ("model", "identity", "character")]
        character = ", ".join(dict.fromkeys(p for p in character_bits if p))
        if character:
            mapped["character"] = character

        # Локация → Environment
        if mapped.get("location") and not mapped.get("environment"):
            mapped["environment"] = mapped["location"]

        return mapped

    def _resolve_profile(self, name: str):
        """Найти объект профиля режиссёра по имени (или None)."""
        try:
            from hermes.design.director_profiles import get_profile, ALL_PROFILES
            profile = get_profile(name)
            if profile:
                return profile
            name_lower = name.lower().strip()
            for p in ALL_PROFILES.values():
                if name_lower in p.name.lower():
                    return p
        except ImportError:
            pass
        return None

    def _apply_proposal(self, proposal: dict):
        """Применить proposal из трансформера к графу (I-004: Decision-Driven State).

        Маршрутизация по block — строит правильный граф (Source→Intent→Goal→Decision):
          "source"     → graph.record_source()
          "intent"     → graph.record_intent()
          "goal"       → graph.record_goal()
          "constraint" → graph.record_constraint()
          "blueprint"  → graph.record_blueprint()
          "artifact"   → graph.record_artifact()
          остальное    → graph.record_decision()
        """
        block = proposal.get("block", "general")
        field = proposal.get("field", "")
        value = proposal.get("value", "")
        source = proposal.get("source", "system")
        confidence = proposal.get("confidence", 0.5)
        rationale = proposal.get("rationale", "")

        # I-009: Intent Integrity — reject overwrite of locked intent
        if block == "intent" and self._lock_intent:
            violation = self._validate_intent_integrity(block, field, value, source)
            if violation:
                return

        # Route by block type — строим правильный граф
        if block == "source" and value:
            self.graph.record_source(value)
            self.evaluator.add_decision(block, field, value, source)
            return

        if block == "intent" and value:
            self.graph.record_intent(value)
            self.evaluator.add_decision(block, field, value, source)
            return

        if block == "goal" and value:
            self.graph.record_goal(value)
            self.evaluator.add_decision(block, field, value, source)
            return

        if block == "constraint" and value:
            constraint_type = field if field in ("must_have", "must_not", "general") else "must_have"
            self.graph.record_constraint(value, constraint_type=constraint_type,
                                          source=source)
            self.evaluator.add_decision(block, field, value, source)
            return

        if block == "blueprint":
            self.graph.record_blueprint()
            self.evaluator.add_decision(block, field, value or "default", source)
            return

        if block == "artifact" and value:
            model_name = self._model_target or "unknown"
            self.graph.record_artifact(value, model=model_name)
            self.evaluator.add_decision(block, field, value, source)
            return

        # Default: Decision node (I-004: Decision-Driven State)
        if field and value:
            self.graph.record_decision(block, field, value,
                                       source=source,
                                       rationale=rationale,
                                       confidence=confidence)
            self.evaluator.add_decision(block, field, value, source)

    def _validate_intent_integrity(self, block: str, field: str,
                                    value: str, source: str) -> Optional[str]:
        """I-009: Проверить целостность Intent — reject overwrite.

        Intent может быть установлен только один раз.
        Любая попытка перезаписать locked intent — отклоняется.

        Returns:
            str — описание нарушения, или None если всё ОК
        """
        if not self._lock_intent:
            return None

        # Если intent уже залочен — сравниваем с предыдущим
        if self._locked_intent_value is not None and field == "description":
            if value != self._locked_intent_value:
                return (
                    f"❌ I-009: Intent already locked: '{self._locked_intent_value[:50]}'. "
                    f"Attempt to overwrite: '{value[:50]}' rejected."
                )
        return None

    def _apply_parsed(self, parsed, block: str = "intent"):
        """Применить распарсенные поля в Registry через Proposal-Decide."""
        for field, value in parsed.fields.items():
            if value and field != "text":
                self._apply_proposal({
                    "block": block, "field": field, "value": str(value),
                    "source": "user",
                    "confidence": 1.0,
                    "rationale": f"Из ответа: {parsed.raw[:50]}",
                })

    def _sde_question(self, blocks: list[str],
                      context: Optional[dict] = None) -> str:
        """Спросить SDE — какой вопрос задать.

        Собирает known_facts из лога решений,
        вызывает SceneDiscoveryEngine,
        fallback на DialogueAgent при ошибке.
        """
        known = {}
        for d in self.graph.logger.decisions:
            if d.block not in known:
                known[d.block] = {}
            known[d.block][d.field] = d.value

        proposal = self.sde.next_question(known, blocks, context)

        if proposal.block == "done":
            # SDE считает что всё известно — fallback на шаблон
            if blocks:
                return self.dialogue.question(blocks[0])
            return "Расскажи подробнее:"

        return proposal.text

    def _export(self, answer: str) -> dict:
        """Экспорт промпта через PromptExporter."""
        model_map = {
            "chatgpt": "chatgpt", "gpt": "chatgpt", "dalle": "chatgpt",
            "midjourney": "midjourney", "mj": "midjourney",
            "nanobanana": "nanobanana", "nano": "nanobanana",
            "flux": "flux", "sdxl": "sdxl",
        }
        target = "chatgpt"
        for k, v in model_map.items():
            if k in answer.lower():
                target = v
                break

        # model_target в отдельную переменную (project может быть SemanticGraph без setter'а)
        self._model_target = target

        project_data, ref = self._prepare_export_data(target)
        prompt = self.exporter.export(project_data, target, ref)
        model_display = SUPPORTED_MODELS.get(target, target.title())

        # ─── Export (record_blueprint + record_artifact через _apply_proposal) ─
        self._apply_proposal({
            "block": "blueprint", "field": "description",
            "value": f"Prompt for {model_display}",
            "source": "system", "confidence": 1.0,
        })
        self._apply_proposal({
            "block": "artifact", "field": "prompt",
            "value": prompt, "source": "system",
            "confidence": 1.0,
        })

        self.state.status = "done"
        self.state.last_result = {
            "type": "done",
            "text": f"✅ **Промпт для {model_display} готов!**",
            "prompt": prompt,
            "model": model_display,
            "switch_available": True,
        }
        return self.state.last_result

    def switch_model(self, model_name: str) -> dict:
        """Переключить модель после готового промпта."""
        artifacts = self.registry.get_nodes(
            __import__('hermes.kernel.core', fromlist=['NodeType']).NodeType.ARTIFACT
        )
        if not artifacts:
            return {"type": "error", "text": "Нет данных — сначала цикл"}

        m = {"chatgpt":"chatgpt","gpt":"chatgpt","dalle":"chatgpt",
             "midjourney":"midjourney","mj":"midjourney",
             "nanobanana":"nanobanana","nano":"nanobanana",
             "flux":"flux","sdxl":"sdxl"}
        target = "chatgpt"
        for k, v in m.items():
            if k in model_name.lower():
                target = v
                break

        project_data, ref = self._prepare_export_data(target)
        prompt = self.exporter.export(project_data, target, ref)
        model_display = SUPPORTED_MODELS.get(target, target.title())

        self.state.last_result = {
            "type": "done", "model": model_display,
            "text": f"✅ **Промпт для {model_display} готов!**\n\n```\n{prompt}\n```",
            "prompt": prompt, "switch_available": True,
        }
        return self.state.last_result

    def summary(self) -> dict:
        """Сводка сессии."""
        return {
            "session_id": self.state.session_id,
            "status": self.state.status,
            "phase": self._phase,
            "category": self._current_category,
            "profile": self._current_profile.name if self._current_profile else "",
            "registry": self.registry.summary(),
            "project": self.project.summary(),
            "decisions": len(self.graph.logger),
        }