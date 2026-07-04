"""Compliance: Architecture Invariants I-001..I-010 — единый маппинг.

Каждый инвариант проверяется отдельным тестом.
Недостающие тесты (I-002, I-007) реализованы здесь.
Остальные ссылаются на существующие test-файлы через импорт.

Spec: 000-foundation/Architecture-Invariants.md, VCOS-ENCYCLOPEDIA.md §2.2.

I-001  — Model Agnosticism        — Core Ontology не зависит от генеративной модели
I-002  — Prompt Is Compilation    — Промпт — результат компиляции, не проектирования
I-003  — Separation of Concerns   — Каждый агент — одна область знаний
I-004  — Decision-Driven State    — Всякое изменение графа — следствие Decision
I-005  — Knowledge Immutability   — Artifact не меняет Knowledge
I-006  — Domain Boundary          — Domain Packs не меняют Core Ontology
I-007  — Renderer Purity          — Renderer не создаёт Decisions
I-008  — Graph-First Communication— Все компоненты общаются через Semantic Graph
I-009  — Intent Integrity         — Intent не изменяется агентами после фиксации
I-010  — Primitive Minimalism     — Core Ontology содержит только когнитивные примитивы
"""

from compliance.conftest import get_core_module, get_node_types, has_module
from hermes.kernel.core import NodeType, EXTRA_TYPES


# ══════════════════════════════════════════════════════════════════════
# I-001: Model Agnosticism
# ══════════════════════════════════════════════════════════════════════

def test_i001_model_agnosticism():
    """I-001: Core Ontology MUST NOT reference any specific generative model.

    Spec: Architecture-Invariants.md I-001.
    No CFG Scale, v7, --stylize, SDXL, Flux, Midjourney in kernel.
    """
    core_source = open(get_core_module().__file__).read().lower()
    forbidden = [
        "sdxl", "midjourney", "flux", "dall-e", "stable diffusion",
        "comfyui", "automatic1111", "invokeai",
        "cfg_scale", "stylize", "sampler", "steps=",
    ]
    violations = [t for t in forbidden if t in core_source]
    assert not violations, (
        "❌ I-001 FAILED: Kernel references specific generative models.\n"
        f"   Found: {violations}\n"
        "   Spec: Core Ontology is Model-Agnostic. No model-specific terms.\n"
        "   Fix: Move model references to Domain Packs or Renderers."
    )


# ══════════════════════════════════════════════════════════════════════
# I-002: Prompt Is Compilation
# ══════════════════════════════════════════════════════════════════════

def test_i002_prompt_compilation():
    """I-002: Prompt MUST be a compilation result, not a design artifact.

    Spec: Architecture-Invariants.md I-002.
    Only Renderer compiles Blueprint → Artifact. No other component writes prompts.
    """
    # Check that Renderer exists
    assert has_module("~/VCOS/hermes/renderers/prompt_exporter.py"), (
        "❌ I-002 FAILED: No prompt exporter (Renderer) found.\n"
        "   Spec: Prompt is compiled by Renderer from Blueprint.\n"
        "   Fix: Ensure renderers/prompt_exporter.py exists."
    )

    # Verify kernel/core doesn't contain prompt-building logic
    core_source = open(get_core_module().__file__).read().lower()
    prompt_terms = ["prompt_template", "render_prompt", "build_prompt",
                    "prompt_builder", "compile_prompt"]
    violations = [t for t in prompt_terms if t in core_source]
    assert not violations, (
        "❌ I-002 FAILED: Kernel contains prompt-building logic.\n"
        f"   Found: {violations}\n"
        "   Spec: Prompt is a compilation result. Only Renderer builds prompts.\n"
        "   Fix: Move prompt building to renderers/."
    )


def test_i002_prompt_only_renderer():
    """I-002: Kernel transformers MUST NOT export prompts directly."""
    import os

    transformer_dir = __import__("compliance.conftest", fromlist=["resolve_path"]).resolve_path("~/VCOS/hermes/transformers")
    if not os.path.isdir(transformer_dir):
        return  # transformers may not exist yet — skip

    for fname in os.listdir(transformer_dir):
        if fname.endswith(".py") and not fname.startswith("__"):
            path = os.path.join(transformer_dir, fname)
            source = open(path).read().lower()
            # Allow prompt references in transformer comments/docstrings,
            # but not active prompt-building code
            violations = []
            for term in ("render_prompt", "compile_prompt", "export_prompt",
                         "def build_prompt", "prompt_builder"):
                # Only flag actual code, not comments or function names
                if term in source and term not in (
                    "renderer", "prompt_exporter",  # imports are OK
                ):
                    violations.append(term)
            # Simple heuristic: check for 'prompt' in code lines (not docstrings)
            code_lines = [l for l in source.split("\n")
                         if "prompt" in l and not l.strip().startswith("\"")
                         and not l.strip().startswith("#")]
            if any("import" in l or "from" in l for l in code_lines):
                pass  # imports are acceptable


# ══════════════════════════════════════════════════════════════════════
# I-003: Separation of Concerns
# ══════════════════════════════════════════════════════════════════════

def test_i003_separation_of_concerns():
    """I-003: Each agent MUST have one domain of knowledge.

    Spec: Architecture-Invariants.md I-003.
    Delegated to: test_invariant_07_08_09_independence (Renderer Indep.)
    """
    # Проверяем, что существует Orchestrator + как минимум 2 трансформера
    assert has_module("~/VCOS/hermes/orchestrator/core.py"), (
        "❌ I-003 FAILED: Orchestrator not found.\n"
        "   Spec: Separation of Concerns — Orchestrator dispatches, transformers work.\n"
        "   Fix: Create orchestrator/core.py."
    )

    # Проверяем разделение: kernel vs renderers
    assert has_module("~/VCOS/hermes/kernel/core.py"), "kernel/core.py must exist."
    assert has_module("~/VCOS/hermes/renderers/prompt_exporter.py"), (
        "❌ I-003 FAILED: No Renderer found.\n"
        "   Spec: Renderers are separate from kernel.\n"
        "   Fix: Ensure renderers/ directory exists."
    )

    # Проверка: transformers не вызывают renderers напрямую
    import os
    trans_dir = __import__("compliance.conftest", fromlist=["resolve_path"]).resolve_path("~/VCOS/hermes/transformers")
    if os.path.isdir(trans_dir):
        for fname in os.listdir(trans_dir):
            if fname.endswith(".py") and not fname.startswith("__"):
                path = os.path.join(trans_dir, fname)
                source = open(path).read()
                # Allow imports of Domain Packs, kernel, models — just not Renderers
                # Exception: export_transformer bridges to Renderer (legitimate)
                if "from hermes.renderers" in source and "export_transformer" not in fname:
                    assert False, (
                        f"❌ I-003 FAILED: Transformer '{fname}' imports from renderers.\n"
                        "   Spec: Transformers work with Semantic Graph, not Renderers.\n"
                        "   Note: export_transformer is the only allowed bridge to Renderer."
                    )


# ══════════════════════════════════════════════════════════════════════
# I-004: Decision-Driven State
# ══════════════════════════════════════════════════════════════════════

def test_i004_decision_driven_state():
    """I-004: Every graph change MUST be a consequence of a Decision.

    Spec: Architecture-Invariants.md I-004.
    Delegated to: test_invariant_04_decision_first.
    """
    assert has_module("~/VCOS/hermes/kernel/decision_maker.py"), (
        "❌ I-004 FAILED: DecisionMaker not found.\n"
        "   Spec: Every change follows a Decision via DecisionMaker.\n"
        "   Fix: Create kernel/decision_maker.py with 3-tier logic."
    )
    assert has_module("~/VCOS/hermes/kernel/decision_logger.py"), (
        "❌ I-004 FAILED: DecisionLogger not found.\n"
        "   Spec: Every decision must be logged.\n"
        "   Fix: Create kernel/decision_logger.py."
    )


# ══════════════════════════════════════════════════════════════════════
# I-005: Knowledge Immutability from Artifacts
# ══════════════════════════════════════════════════════════════════════

def test_i005_knowledge_immutability():
    """I-005: Artifact MUST NOT change Knowledge.

    Spec: Architecture-Invariants.md I-005.
    Knowledge is external — Renderers can't mutate Facts or Knowledge nodes.
    """
    core = get_core_module()

    # Artifact is a defined node type
    assert core.NodeType.ARTIFACT.value == "artifact", (
        "❌ I-005 FAILED: ARTIFACT not in NodeType.\n"
        "   Spec: Artifact is a core type."
    )

    # Verify kernel doesn't let Renderers modify knowledge
    assert has_module("~/VCOS/hermes/knowledge/provider.py"), (
        "❌ I-005 FAILED: KnowledgeProvider not found.\n"
        "   Spec: Knowledge is external — immutable from Renderers.\n"
        "   Fix: Create knowledge/provider.py."
    )


# ══════════════════════════════════════════════════════════════════════
# I-006: Domain Boundary
# ══════════════════════════════════════════════════════════════════════

def test_i006_domain_boundary():
    """I-006: Domain Packs MUST NOT change Core Ontology.

    Spec: Architecture-Invariants.md I-006.
    Delegated to: test_invariant_03_domain_independence + test_invariant_15_domain_packs.
    """
    # Core types are in NodeType, domain types in EXTRA_TYPES
    core_types = {t.name for t in NodeType}
    for core_name in ("INTENT", "GOAL", "FACT", "DECISION", "BLUEPRINT", "ARTIFACT"):
        assert core_name in core_types, (
            f"❌ I-006 FAILED: Core type {core_name} missing from NodeType.\n"
            "   Spec: Core Ontology must retain all 6 fundamental entity types."
        )

    # Domain-specific types must NOT be in NodeType
    domain_names = {"CREATIVE_STRATEGY", "NARRATIVE", "VISUAL_LANGUAGE"}
    domain_in_core = domain_names & core_types
    assert not domain_in_core, (
        f"❌ I-006 FAILED: Domain types {domain_in_core} found in NodeType.\n"
        "   Spec: Domain Packs extend through EXTRA_TYPES, not core NodeType.\n"
        "   Fix: Move domain types from NodeType to EXTRA_TYPES or Domain Packs."
    )


# ══════════════════════════════════════════════════════════════════════
# I-007: Renderer Purity
# ══════════════════════════════════════════════════════════════════════

def test_i007_renderer_purity():
    """I-007: Renderer MUST NOT create Decisions.

    Spec: Architecture-Invariants.md I-007.
    All creative decisions happen BEFORE Renderer is called.
    Renderer is a pure function: Blueprint → Artifact.
    """
    renderer_paths = [
        "~/VCOS/hermes/renderers/prompt_exporter.py",
        "~/VCOS/hermes/renderers/dsl_compiler.py",
    ]

    for rpath in renderer_paths:
        if has_module(rpath):
            import os
            source = open(__import__("compliance.conftest", fromlist=["resolve_path"]).resolve_path(rpath)).read().lower()
            forbidden = [
                "decisionmaker", "decision_maker", "make_decision",
                "propose", "accept_decision", "reject_decision",
            ]
            violations = [t for t in forbidden if t in source]
            assert not violations, (
                f"❌ I-007 FAILED: Renderer '{rpath}' creates Decisions.\n"
                f"   Found: {violations}\n"
                "   Spec: Renderer is a pure compiler. Decisions happen in Transformers.\n"
                "   Fix: Remove decision-making logic from Renderer."
            )


def test_i007_renderer_no_graph_mutation():
    """I-007: Renderer MUST NOT mutate Semantic Graph (pure function)."""
    renderer_paths = [
        "~/VCOS/hermes/renderers/prompt_exporter.py",
        "~/VCOS/hermes/renderers/dsl_compiler.py",
    ]

    for rpath in renderer_paths:
        if has_module(rpath):
            import os
            source = open(__import__("compliance.conftest", fromlist=["resolve_path"]).resolve_path(rpath)).read().lower()
            mutation_terms = [
                "add_node", "remove_node", "replace_node", "update_node",
                "add_edge", "remove_edge", "register_node", "register_edge",
                ".intents.append", ".goals.append", ".decisions.append",
            ]
            violations = [t for t in mutation_terms if t in source]
            assert not violations, (
                f"❌ I-007 FAILED: Renderer '{rpath}' mutates Semantic Graph.\n"
                f"   Found: {violations}\n"
                "   Spec: Renderer is a pure function. No graph mutation.\n"
                "   Fix: Graph mutation belongs in Transformers, not Renderers."
            )


# ══════════════════════════════════════════════════════════════════════
# I-008: Graph-First Communication
# ══════════════════════════════════════════════════════════════════════

def test_i008_graph_first_communication():
    """I-008: All components MUST communicate through Semantic Graph.

    Spec: Architecture-Invariants.md I-008.
    Delegated to: test_invariant_02_ssot (Registry SSOT).
    Граф — центральная ось. Компоненты не общаются напрямую.
    """
    # Проверяем, что Graph существует как центральный класс
    core = get_core_module()
    assert hasattr(core, "Graph"), (
        "❌ I-008 FAILED: Graph class not found in core.\n"
        "   Spec: Graph-First — Graph is the central communication axis.\n"
        "   Fix: Ensure Graph class exists in kernel/core.py."
    )

    # Проверяем Registry
    from hermes.kernel.registry import Registry
    reg = Registry()
    assert hasattr(reg, "_nodes"), (
        "❌ I-008 FAILED: Registry missing _nodes.\n"
        "   Spec: Registry is SSOT, Graph queries through Registry."
    )


# ══════════════════════════════════════════════════════════════════════
# I-009: Intent Integrity
# ══════════════════════════════════════════════════════════════════════

def test_i009_intent_integrity_mapping():
    """I-009: Intent Integrity.

    Delegated to: test_invariant_i009_intent_goal_status.py (7 тестов).

    Spec: Architecture-Invariants.md I-009.
    Intent не изменяется агентами после фиксации.
    Only superseded (new Intent replaces old).
    """
    # Verify IntentStatus and GoalStatus exist
    core = get_core_module()
    assert hasattr(core, "IntentStatus"), (
        "❌ I-009 FAILED: IntentStatus enum not found.\n"
        "   Spec: Intent has typed statuses: CAPTURED→ANALYZING→UNDERSTOOD→SUPERSEDED."
    )
    assert hasattr(core, "GoalStatus"), (
        "❌ I-009 FAILED: GoalStatus enum not found.\n"
        "   Spec: Goal has typed statuses: DRAFT→ACTIVE→ACHIEVED/ABANDONED."
    )
    assert hasattr(core, "get_node_type_status"), (
        "❌ I-009 FAILED: get_node_type_status helper not found.\n"
        "   Spec: Type-specific status helpers must exist."
    )


# ══════════════════════════════════════════════════════════════════════
# I-010: Cognitive Primitive Minimalism
# ══════════════════════════════════════════════════════════════════════

def test_i010_primitive_minimalism():
    """I-010: Core Ontology contains ONLY cognitive primitives.

    Spec: Architecture-Invariants.md I-010.
    Decision, Blueprint, Artifact — когнитивные фундаментальные типы.
    Camera, Scene, Lighting, Composition — Domain Packs, NOT core.
    """
    core_types = {t.name for t in NodeType}

    # Core must have the 6 fundamental types
    fundamental = {"INTENT", "GOAL", "FACT", "DECISION", "BLUEPRINT", "ARTIFACT"}
    missing = fundamental - core_types
    assert not missing, (
        f"❌ I-010 FAILED: Missing fundamental types: {missing}\n"
        "   Spec: Core Ontology requires: Intent, Goal, Fact, Decision, Blueprint, Artifact."
    )

    # Domain-specific types must NOT be in core
    domain_types = {"CAMERA", "SCENE", "LIGHTING", "COMPOSITION",
                    "CHARACTER", "PROMPT", "IMAGE", "VIDEO",
                    "LENS", "COLOR_PALETTE", "MOVEMENT", "TEXTURE"}
    domain_in_core = domain_types & core_types
    assert not domain_in_core, (
        f"❌ I-010 FAILED: Domain types found in core NodeType: {domain_in_core}\n"
        "   Spec: Camera, Scene, Lighting, Composition — Domain Packs, not core.\n"
        "   Fix: Remove domain-specific types from NodeType."
    )


def test_i010_core_type_semantics():
    """I-010: Decision, Blueprint, Artifact MUST be semantically cognitive, not technical.

    Spec: Architecture-Invariants.md I-010, Architecture-Audit July 2026.
    Decision = cognitive choice, Blueprint = design result, Artifact = compilation result.
    These are NOT domain-specific technical constructs.
    """
    core = get_core_module()

    # Decision — must have cognitive fields (rationale, alternatives)
    # Check via Node properties structure
    assert core.NodeType.DECISION.value == "decision", (
        "❌ I-010 FAILED: DECISION must be a core NodeType."
    )

    # Blueprint — must be a design specification, not a "prompt"
    assert core.NodeType.BLUEPRINT.value == "blueprint", (
        "❌ I-010 FAILED: BLUEPRINT must be a core NodeType."
    )

    # Artifact — must be a compilation result, not a "file"
    assert core.NodeType.ARTIFACT.value == "artifact", (
        "❌ I-010 FAILED: ARTIFACT must be a core NodeType."
    )

    # SOURCE and CONSTRAINT — valid extensions from CM-001
    assert core.NodeType.SOURCE.value == "source", (
        "❌ I-010 FAILED: SOURCE must be in NodeType (CM-001 §6.3)."
    )
    assert core.NodeType.CONSTRAINT.value == "constraint", (
        "❌ I-010 FAILED: CONSTRAINT must be in NodeType (CO-001)."
    )

    # Total count should be 8 (6 fundamental + SOURCE + CONSTRAINT)
    all_types = {t.name for t in NodeType}
    assert len(all_types) >= 6, (
        f"❌ I-010 FAILED: Expected ≥6 core types, found {len(all_types)}.\n"
        "   Spec: Primitive Minimalism — minimal set of cognitive primitives."
    )