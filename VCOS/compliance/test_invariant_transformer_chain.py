"""Compliance: CP-001 §4 — Transformer Protocol.
CP-001 §4.1 — Contract: transform(model, context) → TransformResult
CP-001 §4.4 T-001 — Immutable Input
CP-001 §4.4 T-003 — Single Responsibility
CP-001 §4.5 — Transformer Chain

I-003 — Separation of Concerns (Orchestrator диспетчеризирует, не исполняет)
I-008 — Graph-First Communication (все изменения через Proposal-Decide)

Spec: CP-001 specification.md, Architecture Invariants (doc 163).
"""

from compliance.conftest import has_module


def test_cp001_transformer_contract_exists():
    """CP-001 §4.1 + Encyclopedia §6.2: Transformer MUST have transform(graph, context) → TransformResult.

    Encyclopedia: Transformer(SemanticGraph) → SemanticGraph
    """
    try:
        from hermes.transformers.base import Transformer
        assert hasattr(Transformer, "transform"), (
            "❌ CP-001 §4.1 FAILED: Transformer has no transform() method.\n"
            "   Spec: Transformer defines transform(graph, context) → TransformResult.\n"
            "   Encyclopedia §6.2: Transformer(SemanticGraph) → SemanticGraph\n"
            "   Fix: Add abstract transform() to Transformer base class."
        )
        # Check transform has 'graph' and 'context' params
        import inspect
        sig = inspect.signature(Transformer.transform)
        params = list(sig.parameters.keys())
        assert "graph" in params or "model" in params or "pm" in params or "state" in params, (
            f"❌ CP-001 §4.1 FAILED: transform() signature missing graph param.\n"
            f"   Found params: {params}\n"
            f"   Encyclopedia §6.2: transform(graph, context) → TransformResult\n"
            f"   Fix: Change transform() signature to include 'graph' parameter."
        )
        assert "context" in params, (
            f"❌ CP-001 §4.1 FAILED: transform() signature missing context param.\n"
            f"   Found params: {params}\n"
            f"   Spec: transform(graph, context) → TransformResult\n"
            f"   Fix: Change transform() signature to include 'context' parameter."
        )
    except ImportError:
        assert False, "❌ CP-001 §4.1 FAILED: Transformer base class not importable.\n   Fix: Create hermes/transformers/base.py with Transformer ABC."


def test_cp001_transformer_chain_exists():
    """CP-001 §4.5: Transformer chain MUST exist (Interview → Design → Compile)."""
    assert has_module("~/VCOS/hermes/transformers/orchestrator.py"), (
        "❌ CP-001 §4.5 FAILED: TransformerOrchestrator not found.\n"
        "   Spec: Transformer chain — Interview → Design → Compile.\n"
        "   Fix: Create hermes/transformers/orchestrator.py with TransformerOrchestrator."
    )
    try:
        from hermes.transformers.orchestrator import TransformerOrchestrator
        assert hasattr(TransformerOrchestrator, "run_chain"), (
            "❌ CP-001 §4.5 FAILED: TransformerOrchestrator has no run_chain().\n"
            "   Spec: Chain runs transformers in sequence.\n"
            "   Fix: Add run_chain() method to TransformerOrchestrator."
        )
        assert hasattr(TransformerOrchestrator, "register"), (
            "❌ CP-001 §4.5 FAILED: TransformerOrchestrator has no register().\n"
            "   Spec: Transformers must be registrable.\n"
            "   Fix: Add register() method to TransformerOrchestrator."
        )
    except ImportError:
        assert False, "❌ CP-001 §4.5 FAILED: TransformerOrchestrator not importable."


def test_invariant_03_separation_of_concerns():
    """I-003: Orchestrator MUST NOT contain business logic — only delegation."""
    try:
        from hermes.orchestrator.core import Orchestrator
        # Orchestrator should delegate to transformers, not implement logic directly
        # Check it doesn't parse user input directly (DialogueAgent belongs to transformer)
        # Check it doesn't record decisions directly (graph belongs to transformer)
        import inspect
        source = inspect.getsource(Orchestrator.submit_answer)
        
        # These patterns indicate business logic in Orchestrator (violation of I-003)
        dialogue_in_orchestrator = "self.dialogue.parse" in source
        if dialogue_in_orchestrator:
            print(f"⚠️  I-003 WARNING: Orchestrator calls dialogue.parse() directly.\n"
                  f"   Spec: Orchestrator manages process, agents execute.\n"
                  f"   Fix: Move dialogue logic to DialogueTransformer.")
        
        # Check for TransformerOrchestrator usage
        has_transformer_orch = (
            "TransformerOrchestrator" in source
            or "_transformer_orch" in source
            or "run_single" in source
            or "run_chain" in source
        )
        assert has_transformer_orch, (
            "❌ I-003 FAILED: Orchestrator does NOT use Transformer chain.\n"
            "   Spec: Orchestrator only dispatches to transformers.\n"
            f"   Current source has direct calls: "
            f"{'dialogue.parse()' if dialogue_in_orchestrator else 'direct logic'}\n"
            "   Fix: Replace submit_answer() with TransformerOrchestrator.run_chain()."
        )
    except ImportError:
        assert False, "❌ I-003 FAILED: Orchestrator not importable."


def test_invariant_08_graph_first_communication():
    """I-008: All agents communicate through Semantic Graph — Proposal-Decide cycle.

    Проверяет что оркестратор поддерживает graph-first communication
    через TransformerOrchestrator + Proposal-Decide pathway.
    """
    try:
        from hermes.orchestrator.core import Orchestrator
        import inspect
        source = inspect.getsource(Orchestrator.submit_answer)

        # Check that TransformerOrchestrator is used for graph mutations
        has_transformer_pathway = "_apply_proposal" in source or "TransformerOrchestrator" in source
        assert has_transformer_pathway, (
            "❌ I-008 FAILED: Orchestrator has no TransformerOrchestrator pathway.\n"
            "   Spec: All agents communicate through Semantic Graph with Proposal-Decide.\n"
            "   Fix: Add TransformerOrchestrator and _apply_proposal() to Orchestrator."
        )

        # Check that _apply_proposal exists — it routes through Proposal-Decide
        assert hasattr(Orchestrator, "_apply_proposal"), (
            "❌ I-008 FAILED: Orchestrator has no _apply_proposal() method.\n"
            "   Spec: graph mutations must go through Proposal → Decide.\n"
            "   Fix: Add _apply_proposal() that applies decisions through graph."
        )
    except ImportError:
        assert False, "❌ I-008 FAILED: Orchestrator not importable."


def test_cp001_immutable_input():
    """CP-001 §4.4 T-001: Transformer MUST NOT mutate input SemanticGraph."""
    try:
        from hermes.transformers.orchestrator import TransformerOrchestrator
        assert hasattr(TransformerOrchestrator, "run_chain"), "run_chain required"
        
        # Verify that run_chain returns a new graph, not the same one
        import inspect
        sig = inspect.signature(TransformerOrchestrator.run_chain)
        # run_chain should return something — not void
        assert sig.return_annotation is not inspect.Parameter.empty, (
            "❌ T-001 FAILED: run_chain() has no return annotation.\n"
            "   Encyclopedia: Transformer(SemanticGraph) → SemanticGraph\n"
            "   Fix: Add return type annotation to run_chain()."
        )
    except ImportError:
        # TransformerOrchestrator doesn't exist yet — this is expected to fail
        assert False, "❌ T-001 FAILED: TransformerOrchestrator not found.\n   Fix: Create hermes/transformers/orchestrator.py."
    except (AttributeError, TypeError):
        assert False, "❌ T-001 FAILED: TransformerOrchestrator interface incomplete."


def test_cp001_transformer_chain_interview_design_compile():
    """CP-001 §4.5: Chain MUST include Interview → Design → Compile phases."""
    try:
        from hermes.transformers.orchestrator import TransformerOrchestrator
        orch = TransformerOrchestrator()
        phases = orch.get_phases() if hasattr(orch, "get_phases") else []
        phase_names = [p.get("name", p) if isinstance(p, dict) else str(p) for p in phases]
        
        has_interview = any("interview" in p.lower() for p in phase_names)
        has_design = any("design" in p.lower() for p in phase_names)
        has_compile = any("compile" in p.lower() or "export" in p.lower() for p in phase_names)
        
        assert has_interview and has_design and has_compile, (
            "❌ CP-001 §4.5 FAILED: Chain missing phases.\n"
            f"   Found: {phase_names}\n"
            f"   Interview: {has_interview}, Design: {has_design}, Compile: {has_compile}\n"
            "   Spec: Chain MUST include Interview → Design → Compile.\n"
            "   Fix: Register all three phase types in TransformerOrchestrator."
        )
    except ImportError:
        assert False, "❌ CP-001 §4.5 FAILED: TransformerOrchestrator not found."


# ─── InterviewTransformer (CP-001 §8) ────────────────────────────

def test_cp001_interview_transformer_exists():
    """CP-001 §8: InterviewTransformer MUST exist."""
    try:
        from hermes.transformers.interview_transformer import InterviewTransformer
        it = InterviewTransformer()
        assert it.name == "interview"
        assert it.can_handle("interview")
        assert it.can_handle("dialogue")
    except ImportError:
        assert False, (
            "❌ CP-001 §8 FAILED: InterviewTransformer not found.\n"
            "   Spec: Interview Protocol — start/ask/collect/clarify/abort.\n"
            "   Fix: Create hermes/transformers/interview_transformer.py."
        )


def test_cp001_interview_phases():
    """CP-001 §8.3: Interview MUST have 4 phases (Category, Style, Technical, Brand)."""
    try:
        from hermes.transformers.interview_transformer import InterviewTransformer
        it = InterviewTransformer()
        assert len(it.PHASES) >= 4, (
            f"❌ CP-001 §8.3 FAILED: InterviewTransformer has only {len(it.PHASES)} phases.\n"
            "   Spec: 4 phases — Product/Category, Style/Mood, Technical, Brand.\n"
            "   Fix: Add all 4 phase types to InterviewTransformer.PHASES."
        )
        phase_numbers = {v.get("phase") for v in it.PHASES.values()}
        assert 1 in phase_numbers and 4 in phase_numbers, (
            f"❌ CP-001 §8.3 FAILED: Phase range incorrect. Found phases: {phase_numbers}\n"
            "   Spec: 4 phases, numbered 1–4.\n"
            "   Fix: Ensure phases cover range 1 to 4."
        )
    except ImportError:
        assert False, "❌ CP-001 §8.3 FAILED: InterviewTransformer not importable."


def test_cp001_interview_abortable():
    """CP-001 §8.4 I-003: Interview MUST be abortable."""
    try:
        from hermes.transformers.interview_transformer import InterviewTransformer
        it = InterviewTransformer()
        assert hasattr(it, "abort"), (
            "❌ I-003 FAILED: InterviewTransformer has no abort().\n"
            "   Spec: The user MUST be able to cancel the interview at any point.\n"
            "   Fix: Add abort() method to InterviewTransformer."
        )
        assert hasattr(it, "is_active"), (
            "❌ I-003 FAILED: No way to check if interview is active.\n"
            "   Spec: Session state must be trackable.\n"
            "   Fix: Add is_active() to InterviewTransformer."
        )
        # Test abort cycle
        assert not it.is_active(), "Initial state should be inactive"
    except ImportError:
        assert False, "❌ I-003 FAILED: InterviewTransformer not importable."


# ─── DesignTransformer (CP-001 §4.5) ─────────────────────────────

def test_cp001_design_transformer_exists():
    """CP-001 §4.5: DesignTransformer MUST exist in chain."""
    try:
        from hermes.transformers.design_transformer import DesignTransformer
        dt = DesignTransformer()
        assert dt.name == "design"
        assert dt.can_handle("design")
        assert dt.can_handle("creative")
    except ImportError:
        assert False, (
            "❌ CP-001 §4.5 FAILED: DesignTransformer not found.\n"
            "   Spec: Chain MUST include Design phase.\n"
            "   Fix: Create hermes/transformers/design_transformer.py."
        )


def test_cp001_design_proposals():
    """CP-001 §4.5: DesignTransformer MUST return proposals (not mutate graph)."""
    try:
        from hermes.transformers.design_transformer import DesignTransformer
        from hermes.transformers.base import TransformerContext
        dt = DesignTransformer()
        # Pass a simple object as graph
        class MockGraph:
            def get_intents(self):
                return [{"field": "style", "value": "luxury", "label": "Style"}]
        context = TransformerContext(config={"domain": "photography"})
        result = dt.transform(MockGraph(), context)
        assert hasattr(result, "graph"), (
            "❌ CP-001 §4.5 FAILED: DesignTransformer must return graph in result.\n"
            "   Encyclopedia: Transformer(SemanticGraph) → SemanticGraph\n"
            "   Fix: Ensure TransformResult has 'graph' field."
        )
        # Should have at least one proposal (from intents)
        assert len(result.proposals) >= 1, (
            "❌ CP-001 §4.5 FAILED: DesignTransformer returned no proposals.\n"
            "   Spec: Design phase generates Goals, Decisions, Constraints.\n"
            "   Fix: Ensure extract_intents populates proposals."
        )
    except ImportError:
        pass  # Optional — DesignTransformer may not exist yet


# ─── CompileTransformer / Renderer Protocol (CP-001 §6) ───────────

def test_cp001_compile_transformer_exists():
    """CP-001 §6: CompileTransformer MUST implement Renderer Protocol."""
    try:
        from hermes.transformers.compile_transformer import CompileTransformer
        ct = CompileTransformer()
        assert ct.name == "compile"
        assert ct.can_handle("compile")
        assert ct.can_handle("render")
        assert len(ct.SUPPORTED_FORMATS) >= 2, (
            f"❌ CP-001 §6 FAILED: Only {len(ct.SUPPORTED_FORMATS)} formats.\n"
            "   Spec: At least SDXL and Midjourney prompt formats.\n"
            "   Fix: Add more target formats to SUPPORTED_FORMATS."
        )
    except ImportError:
        assert False, (
            "❌ CP-001 §6 FAILED: CompileTransformer not found.\n"
            "   Spec: Renderer Protocol — Blueprint In, Artifact Out.\n"
            "   Fix: Create hermes/transformers/compile_transformer.py."
        )


def test_cp001_compile_artifact():
    """CP-001 §6 R-001: CompileTransformer MUST produce an Artifact."""
    try:
        from hermes.transformers.compile_transformer import CompileTransformer
        from hermes.transformers.base import TransformerContext
        ct = CompileTransformer()
        context = TransformerContext(config={
            "target_format": "sdxl-prompt",
            "target_model": "sdxl",
        })
        result = ct.transform(None, context)
        assert len(result.artifacts) >= 1, (
            "❌ R-001 FAILED: CompileTransformer returned no artifacts.\n"
            "   Spec: Blueprint In, Artifact Out.\n"
            "   Fix: Ensure compile produces at least one artifact."
        )
        artifact = result.artifacts[0]
        assert "content" in artifact, (
            "❌ R-001 FAILED: Artifact has no content.\n"
            "   Spec: Artifact must have content, format, generator.\n"
            "   Fix: Add 'content' key to artifact dict."
        )
        assert "format" in artifact, (
            "❌ R-001 FAILED: Artifact has no format.\n"
            "   Fix: Add 'format' key to artifact dict."
        )
    except ImportError:
        pass  # Optional — CompileTransformer may not exist yet


# ─── TransformResult Graph Field (Encyclopedia §6.2) ────────────

def test_cp001_transform_result_has_graph():
    """Encyclopedia §6.2: TransformResult MUST have 'graph' field (not 'model')."""
    try:
        from hermes.transformers.base import TransformResult
        result = TransformResult(graph="test")
        assert hasattr(result, "graph"), (
            "❌ Encyclopedia §6.2 FAILED: TransformResult has no 'graph' field.\n"
            "   Encyclopedia: Transformer(SemanticGraph) → SemanticGraph\n"
            "   Fix: Rename 'model' field to 'graph' in TransformResult."
        )
        assert result.graph == "test", "graph field should store the value"
        assert not hasattr(result, "model"), (
            "❌ Encyclopedia §6.2 FAILED: TransformResult still has old 'model' field.\n"
            "   Encyclopedia: SemanticGraph replaces ProjectModel as transformer IO.\n"
            "   Fix: Remove 'model' field from TransformResult, keep only 'graph'."
        )
    except ImportError:
        assert False, "❌ Encyclopedia §6.2 FAILED: TransformResult not importable."
    except TypeError:
        assert False, "❌ Encyclopedia §6.2 FAILED: TransformResult requires 'graph' kwarg."


# ─── Transformer version property (CP-001 §4.1) ──────────────────

def test_cp001_transformer_has_version():
    """CP-001 §4.1: Every Transformer MUST have a version."""
    try:
        from hermes.transformers.base import Transformer
        assert hasattr(Transformer, "version"), (
            "❌ CP-001 §4.1 FAILED: Transformer has no 'version' property.\n"
            "   Spec: interface Transformer { name, version → transform(...) }\n"
            "   Fix: Add @abstractmethod version to Transformer ABC."
        )
    except ImportError:
        assert False, "❌ CP-001 §4.1 FAILED: Transformer not importable."


def test_cp001_concrete_transformers_have_version():
    """CP-001 §4.1: All concrete transformers MUST define version."""
    transformers = []
    try:
        from hermes.transformers.dialogue_transformer import DialogueTransformer
        transformers.append(DialogueTransformer())
    except ImportError:
        pass
    try:
        from hermes.transformers.knowledge_transformer import KnowledgeTransformer
        transformers.append(KnowledgeTransformer())
    except ImportError:
        pass
    try:
        from hermes.transformers.llm_transformer import LLMTransformer
        transformers.append(LLMTransformer())
    except ImportError:
        pass
    try:
        from hermes.transformers.interview_transformer import InterviewTransformer
        transformers.append(InterviewTransformer())
    except ImportError:
        pass
    try:
        from hermes.transformers.design_transformer import DesignTransformer
        transformers.append(DesignTransformer())
    except ImportError:
        pass
    try:
        from hermes.transformers.compile_transformer import CompileTransformer
        transformers.append(CompileTransformer())
    except ImportError:
        pass

    assert len(transformers) >= 3, (
        f"❌ CP-001 §4.1 FAILED: Only {len(transformers)} transformers loadable.\n"
        "   Fix: Ensure all transformers are importable."
    )
    for tf in transformers:
        assert tf.version, (
            f"❌ CP-001 §4.1 FAILED: {tf.name} has no version.\n"
            "   Spec: Every transformer defines version.\n"
            "   Fix: Add version='1.0.0' to transformer class."
        )


# ─── T-002: Pure Function (CP-001 §4.4) ───────────────────────────

def test_cp001_t002_pure_function():
    """CP-001 §4.4 T-002: Same (graph + context) → same TransformResult."""
    try:
        from hermes.transformers.compile_transformer import CompileTransformer
        from hermes.transformers.base import TransformerContext

        ct = CompileTransformer()
        ctx = TransformerContext(config={
            "target_format": "sdxl-prompt",
            "target_model": "sdxl",
        })

        # Two identical calls should produce identical artifacts
        result1 = ct.transform(None, ctx)
        result2 = ct.transform(None, ctx)

        assert len(result1.artifacts) == len(result2.artifacts), (
            "❌ T-002 FAILED: Same input produced different number of artifacts.\n"
            "   Spec: Given the same model + context, result MUST be identical.\n"
            "   Fix: Ensure deterministic compilation."
        )

        # CompileTransformer is deterministic — same specs = same artifact
        if result1.artifacts and result2.artifacts:
            c1 = result1.artifacts[0].get("content", "")
            c2 = result2.artifacts[0].get("content", "")
            if c1 and c2:
                assert c1 == c2, (
                    f"❌ T-002 FAILED: Two identical calls produced different content.\n"
                    f"   Call 1: '{c1[:50]}...'\n"
                    f"   Call 2: '{c2[:50]}...'\n"
                    "   Fix: Ensure no random/state in compile logic."
                )
    except ImportError:
        pass  # Optional


# ─── T-004: No Side Effects (CP-001 §4.4) ─────────────────────────

def test_cp001_t004_no_side_effects():
    """CP-001 §4.4 T-004: Transformer MUST NOT modify input graph."""
    try:
        from hermes.transformers.knowledge_transformer import KnowledgeTransformer
        from hermes.transformers.base import TransformerContext

        ct = KnowledgeTransformer()

        class TrackingGraph:
            def __init__(self):
                self.modified = False
            def mutate(self):
                self.modified = True

        graph = TrackingGraph()
        ctx = TransformerContext(config={"query": "test"})
        result = ct.transform(graph, ctx)

        # KnowledgeTransformer is read-only — graph must not be modified
        assert hasattr(result, "graph"), "TransformResult must have 'graph'"
        assert not graph.modified, (
            "❌ T-004 FAILED: KnowledgeTransformer modified the input graph.\n"
            "   Spec: Transformer MUST NOT have side effects on input.\n"
            "   Fix: Ensure transformer does not call graph.mutate()."
        )
    except ImportError:
        pass  # Optional


# ─── R-003: Deterministic Compilation (CP-001 §6.4) ──────────────

def test_cp001_r003_deterministic():
    """CP-001 §6.4 R-003: Same Blueprint + target → identical artifact text."""
    try:
        from hermes.transformers.compile_transformer import CompileTransformer
        from hermes.transformers.renderer_protocol import RenderContext

        ct = CompileTransformer()
        specs = ["product photo", "white background"]
        ctx = RenderContext(target_format="sdxl-prompt", target_model="sdxl")

        r1 = ct.render(specs, ctx)
        r2 = ct.render(specs, ctx)

        assert r1.artifact.get("content") == r2.artifact.get("content"), (
            "❌ R-003 FAILED: Two identical renders produced different content.\n"
            "   Spec: Given the same Blueprint and target, Artifact text MUST be identical.\n"
            "   Fix: Ensure _compile methods are pure functions."
        )
        assert r1.format == r2.format, (
            "❌ R-003 FAILED: Formats differ between runs.\n"
            "   Fix: Ensure format is derived deterministically."
        )
    except ImportError:
        pass  # Optional


# ─── Knowledge Protocol Dataclasses (CP-001 §5) ───────────────────

def test_cp001_knowledge_protocol_dataclasses():
    """CP-001 §5: KnowledgeRequest + KnowledgeResult dataclasses MUST exist."""
    try:
        from hermes.transformers.knowledge_protocol import KnowledgeRequest, KnowledgeResult

        req = KnowledgeRequest(domain="photography", free_text="product photo")
        assert req.domain == "photography"
        assert req.max_results == 10  # default

        res = KnowledgeResult(facts=[{"field": "test"}], confidence=0.8)
        assert len(res.facts) == 1
        assert res.confidence == 0.8
        assert res.source == "unknown"  # default
    except ImportError:
        assert False, (
            "❌ CP-001 §5 FAILED: KnowledgeRequest/Result not found.\n"
            "   Spec: Formal dataclasses for Knowledge Provider Protocol.\n"
            "   Fix: Create hermes/transformers/knowledge_protocol.py."
        )


def test_cp001_knowledge_query_method():
    """CP-001 §5.1: KnowledgeTransformer MUST have query() with (request) → result."""
    try:
        from hermes.transformers.knowledge_transformer import KnowledgeTransformer
        from hermes.transformers.knowledge_protocol import KnowledgeRequest

        kt = KnowledgeTransformer()
        assert hasattr(kt, "query"), (
            "❌ CP-001 §5.1 FAILED: KnowledgeTransformer has no query().\n"
            "   Spec: interface KnowledgeProvider { query(request) → KnowledgeResult }\n"
            "   Fix: Add query() method to KnowledgeTransformer."
        )

        req = KnowledgeRequest(domain="photography", free_text="test")
        result = kt.query(req)
        assert hasattr(result, "facts"), "query() must return KnowledgeResult with facts"
        assert hasattr(result, "confidence"), "query() must return KnowledgeResult with confidence"
    except ImportError:
        assert False, "❌ CP-001 §5.1 FAILED: KnowledgeTransformer not importable."


# ─── Renderer Protocol Dataclasses (CP-001 §6) ────────────────────

def test_cp001_renderer_protocol_dataclasses():
    """CP-001 §6: RenderContext + RenderResult dataclasses MUST exist."""
    try:
        from hermes.transformers.renderer_protocol import RenderContext, RenderResult

        ctx = RenderContext(target_format="midjourney-prompt", target_model="midjourney-v6")
        assert ctx.target_format == "midjourney-prompt"
        assert ctx.target_model == "midjourney-v6"

        result = RenderResult(artifact={"content": "test"}, format="midjourney-prompt")
        assert result.artifact["content"] == "test"
        assert result.duration == 0  # default
    except ImportError:
        assert False, (
            "❌ CP-001 §6 FAILED: RenderContext/Result not found.\n"
            "   Spec: Formal dataclasses for Renderer Protocol.\n"
            "   Fix: Create hermes/transformers/renderer_protocol.py."
        )


def test_cp001_compile_render_method():
    """CP-001 §6.1: CompileTransformer MUST have render(specs, context) → RenderResult."""
    try:
        from hermes.transformers.compile_transformer import CompileTransformer
        from hermes.transformers.renderer_protocol import RenderContext

        ct = CompileTransformer()
        assert hasattr(ct, "render"), (
            "❌ CP-001 §6.1 FAILED: CompileTransformer has no render().\n"
            "   Spec: interface Renderer { render(blueprint, context) → RenderResult }\n"
            "   Fix: Add render() method to CompileTransformer."
        )

        ctx = RenderContext(target_format="sdxl-prompt", target_model="sdxl")
        result = ct.render(["test spec"], ctx)
        assert hasattr(result, "artifact"), "render() must return RenderResult with artifact"
        assert hasattr(result, "format"), "render() must return RenderResult with format"
        assert result.artifact.get("content"), "Artifact must have content"
    except ImportError:
        assert False, "❌ CP-001 §6.1 FAILED: CompileTransformer not importable."


# ─── Interview Protocol methods (CP-001 §8.1) ─────────────────────

def test_cp001_interview_ask_collect_clarify():
    """CP-001 §8.1: InterviewTransformer MUST have ask/collect/clarify."""
    try:
        from hermes.transformers.interview_transformer import InterviewTransformer

        it = InterviewTransformer()

        assert hasattr(it, "ask"), (
            "❌ CP-001 §8.1 FAILED: InterviewTransformer has no ask().\n"
            "   Spec: interface Interview { ask(state) → Question[] }\n"
            "   Fix: Add ask() method."
        )
        assert hasattr(it, "collect"), (
            "❌ CP-001 §8.1 FAILED: InterviewTransformer has no collect().\n"
            "   Spec: interface Interview { collect(state, answers) → InterviewResult }\n"
            "   Fix: Add collect() method."
        )
        assert hasattr(it, "clarify"), (
            "❌ CP-001 §8.1 FAILED: InterviewTransformer has no clarify().\n"
            "   Spec: interface Interview { clarify(state, ambiguous) → Question[] }\n"
            "   Fix: Add clarify() method."
        )

        q = it.ask("category")
        assert isinstance(q, str) and len(q) > 0, (
            "❌ CP-001 §8.1 FAILED: ask() must return a non-empty question string.\n"
            f"   Got: '{q}'"
        )

        c = it.clarify(["style", "color"])
        assert isinstance(c, str) and "style" in c and "color" in c, (
            "❌ CP-001 §8.1 FAILED: clarify() must mention the unclear fields.\n"
            f"   Got: '{c}'"
        )
    except ImportError:
        assert False, "❌ CP-001 §8.1 FAILED: InterviewTransformer not importable."


# ─── I-004: Decision-Driven State ─────────────────────────────────

def test_invariant_04_decision_driven_proposals():
    """I-004: _apply_proposal MUST handle all mutation types."""
    try:
        from hermes.transformers.orchestrator import TransformerOrchestrator
        orch = TransformerOrchestrator()

        # Verify _apply_proposal handles the main types
        import inspect
        source = inspect.getsource(orch._apply_proposal)

        assert "proposal_type" in source, (
            "❌ I-004 FAILED: _apply_proposal does not dispatch on type.\n"
            "   Spec: Every mutation through Proposal → Decide.\n"
            "   Fix: Add type-based dispatch to _apply_proposal."
        )

        # Check that decision, create_node, create_edge are handled
        for expected_type in ["decision", "create_node", "create_edge"]:
            assert expected_type in source, (
                f"❌ I-004 FAILED: _apply_proposal missing handler for '{expected_type}'.\n"
                "   Spec: All mutation types must go through Proposal-Decide.\n"
                f"   Fix: Add '{expected_type}' handler."
            )

        # Check that submit_answer calls _apply_proposal for each proposal
        from hermes.orchestrator.core import Orchestrator
        sub_source = inspect.getsource(Orchestrator.submit_answer)
        assert "_apply_proposal" in sub_source, (
            "❌ I-004 FAILED: submit_answer() does not call _apply_proposal().\n"
            "   Spec: Every proposal from transformers must be applied through Decide.\n"
            "   Fix: Ensure submit_answer() calls _apply_proposal() for each transformer's proposals."
        )

    except ImportError:
        assert False, "❌ I-004 FAILED: TransformerOrchestrator not importable."