# CP-001 — Core Protocols v1.0

**Status:** Draft  
**Version:** 1.0.0  
**Author:** Chief Architect  
**Created:** 2026-07-01  
**Depends on:** [CO-001 — Core Ontology](../../100-core-ontology/CO-001/specification.md), [CM-001 — Canonical Model](../../200-canonical-model/CM-001/specification.md), [CA-001 — Core Algebra](../../300-core-algebra/CA-001/specification.md)

---

## 1. Purpose

CP-001 defines the **contracts** between all components of the VCOS platform.

It answers only one question:

> **How do components interact?**

It does **not** answer:
- *What exists?* — That is CO-001.
- *How is it stored?* — That is CM-001.
- *What operations are valid?* — That is CA-001.

**CP-001 contains no entities, no storage, no operations. Only contracts.**

---

## 2. Scope

CP-001 defines contracts for:

- **Transformer Protocol** — how components transform the Canonical Model
- **Knowledge Provider Protocol** — how domain knowledge enters the system
- **Renderer Protocol** — how Blueprints become Artifacts
- **Memory Protocol** — how persistent memory is accessed
- **Interview Protocol** — how user input becomes structured data
- **Reasoning Protocol** — how LLM is invoked with context

---

## 3. Definitions

| Term | Definition |
|------|-----------|
| **Contract** | A typed interface that defines the boundary between two components |
| **Adapter** | An implementation of a contract for a specific technology (LLM, DB, API) |
| **Transformer** | A stateless function `(ProjectModel, params) → ProjectModel'` |
| **Knowledge Provider** | A source of domain-specific facts and rules |
| **Renderer** | A module that converts Blueprint → Artifact |
| **Memory** | A persistent store that survives project sessions |
| **Interview** | A structured conversation with the user to gather requirements |
| **Reasoning** | An LLM invocation with controlled context |

---

## 4. Transformer Protocol

A Transformer is the **fundamental unit of computation** in Hermes.

### 4.1 Contract

```
interface Transformer {
  name:    string
  version: string

  transform(
    model:    ProjectModel,
    context:  TransformerContext
  ) → TransformResult
}
```

### 4.2 Input

```
TransformerContext {
  registry:    Registry            (all Nodes and Edges)
  knowledge:   KnowledgeProvider[] (available knowledge sources)
  memory:      MemoryAccess         (persistent memory handle)
  interview:   InterviewSession | null  (if interview is active)
  reasoning:   ReasoningEngine     (LLM with controlled context)
  config:      Dict                (transformer-specific parameters)
  metadata:    { sessionID, timestamp, parentTransformer }
}
```

### 4.3 Output

```
TransformResult {
  model:      ProjectModel        (new version — immutable)
  proposals:  Proposal[]           (suggested changes from LLM via this transformer)
  decisions:  DecisionID[]         (decisions recorded during transform)
  snapshots:  SnapshotID[]         (snapshots created during transform)
  artifacts:  ArtifactID[]         (any artifacts generated)
  log:        TransformLog         (trace of what happened)
}
```

### 4.4 Invariants

- **T-001 — Immutable Input.** The Transformer MUST NOT modify the input `ProjectModel`. It must produce a new one.
- **T-002 — Pure Function.** Given the same model + context, a Transformer MUST produce the same result (deterministic).
- **T-003 — Single Responsibility.** A Transformer MUST perform exactly one type of transformation (design, interview, compile, validate).
- **T-004 — No Side Effects.** A Transformer MUST NOT call external APIs directly. All I/O must use the provided context interfaces.

### 4.5 Transformer Chain

```
ProjectModel v1
    │
    ▼
InterviewTransformer
    │
    ▼
ProjectModel v2
    │
    ▼
DesignTransformer
    │
    ▼
ProjectModel v3
    │
    ▼
CompileTransformer
    │
    ▼
ProjectModel v4
```

### 4.6 Example Transformer

```python
class InterviewTransformer(Transformer):
    name = "vcos.interview.v1"
    version = "1.0.0"

    def transform(self, model, context):
        questions = context.interview.ask(model)
        answers = context.interview.collect()
        proposals = context.reasoning.infer(
            prompt="Interpret user answers and propose Intent updates",
            context={ "questions": questions, "answers": answers, "model": model }
        )
        return TransformResult(
            model=model.apply(proposals),
            proposals=[proposals],
            log={"phase": "interview", "questions_asked": len(questions)}
        )
```

---

## 5. Knowledge Provider Protocol

A Knowledge Provider supplies domain-specific information (facts, constraints, rules) to the system.

### 5.1 Contract

```
interface KnowledgeProvider {
  name:     string
  domain:   string[]              (which domains this provider covers)
  version:  string

  query(
    request:  KnowledgeRequest
  ) → KnowledgeResult
}
```

### 5.2 Request

```
KnowledgeRequest {
  domain:    string               (e.g., "photography", "advertising")
  context:   {
    projectType:  string           (e.g., "product-photo")
    constraints:  ConstraintID[]   (active constraints)
    facts:        FactID[]         (known facts)
    freeText:     string | null    (natural language query)
  }
  maxResults: int (default: 10)
}
```

### 5.3 Response

```
KnowledgeResult {
  facts:     Fact[]              (new facts discovered)
  relations: Edge[]              (relationships between facts)
  confidence: float (0-1)        (overall confidence)
  source:    string              (where this knowledge came from)
}
```

### 5.4 Invariants

- **K-001 — Read Only.** Knowledge Providers MUST NOT modify the Canonical Model. They return facts, not mutations.
- **K-002 — Domain Scoped.** Every fact returned MUST be tagged with its domain.
- **K-003 — Cacheable.** Multiple identical queries SHOULD return the same result (idempotent).

### 5.5 Adapter Examples

| Provider | Domain | Implementation |
|----------|--------|---------------|
| Product Photography | `photography` | Built-in rules + LLM |
| Film Language | `film` | Structured knowledge base |
| Brand Guidelines | `advertising` | Loaded from YAML files |
| Composition Rules | `photography` | Rule of Thirds, Golden Ratio |

---

## 6. Renderer Protocol

A Renderer compiles a Blueprint into an Artifact (prompt, image, video, JSON, etc.).

### 6.1 Contract

```
interface Renderer {
  name:         string
  targetFormat: string[]             (e.g., ["sdxl-prompt", "midjourney-prompt"])
  targetModel:  string[]             (e.g., ["sdxl", "midjourney-v6", "flux-pro"])

  render(
    blueprint:  Blueprint,
    context:    RenderContext
  ) → RenderResult
}
```

### 6.2 Input

```
RenderContext {
  targetFormat:  string              (which format to produce)
  targetModel:   string              (which model to target)
  specifications: Spec[]             (structured specs from Blueprint)
  constraints:   Constraint[]        (active constraints to respect)
  options:       RenderOptions       (model-specific parameters)
}
```

### 6.3 Response

```
RenderResult {
  artifact:    Artifact             (the generated artifact)
  params:      Dict                 (generation parameters used)
  format:      string               (actual format produced)
  duration:    int                  (ms)
  log:         RenderLog            (trace of render steps)
}
```

### 6.4 Invariants

- **R-001 — Blueprint In, Artifact Out.** Every Renderer MUST accept a Blueprint and produce exactly one Artifact.
- **R-002 — No Side Effects on Model.** Renderers MUST NOT modify the Canonical Model. They produce Artifacts for the Model.
- **R-003 — Deterministic Compilation.** Given the same Blueprint and target, the Artifact text MUST be identical (the *generation* of the artifact may vary).

### 6.5 Adapter Examples

| Renderer | Target | Output |
|----------|--------|--------|
| Midjourney Prompt Renderer | midjourney-v6 | Midjourney prompt string |
| SDXL Prompt Renderer | sdxl | SDXL prompt with weighting |
| ChatGPT Prompt Renderer | chatgpt-4o | Structured prompt |
| ComfyUI Workflow Renderer | comfyui | workflow.json |
| HTML Infographic Renderer | html | Complete HTML+CSS |

---

## 7. Memory Protocol

Memory provides **persistent storage** that survives across project sessions.

### 7.1 Contract

```
interface Memory {
  name:     string
  provider: string               (e.g., "pgvector", "embeddings", "sqlite")

  store(key: string, value: any, namespace: string) → void
  read(key: string, namespace: string) → any | null
  search(query: string, namespace: string, limit: int) → MemoryResult[]
  delete(key: string, namespace: string) → void
  clear(namespace: string) → void
}
```

### 7.2 Response

```
MemoryResult {
  key:       string
  value:     any
  score:     float (0-1)         (relevance, for semantic search)
  metadata:  {
    createdAt:  Timestamp
    updatedAt:  Timestamp
    agentID:    string
  }
}
```

### 7.3 Namespaces

| Namespace | Contains |
|-----------|----------|
| `user.preferences` | User preferences and recurring patterns |
| `project.{id}.facts` | Facts learned during a project |
| `domain.{name}` | Domain-specific knowledge |
| `system.{version}` | System-wide configuration |

### 7.4 Invariants

- **M-001 — Survives Sessions.** Memory MUST persist across Hermes restarts.
- **M-002 — Versioned.** Memory entries MUST be versioned (createdAt, updatedAt).
- **M-003 — Namespace Isolation.** Operations in one namespace MUST NOT affect others.

---

## 8. Interview Protocol

The Interview protocol defines how the system collects information from the user.

### 8.1 Contract

```
interface Interview {
  name:     string
  version:  string

  start(session: InterviewSession, context: InterviewContext) → InterviewState
  ask(state: InterviewState) → Question[]
  collect(state: InterviewState, answers: Answer[]) → InterviewResult
  clarify(state: InterviewState, ambiguous: Ambiguity[]) → Question[]
  abort(session: InterviewSession) → void
}
```

### 8.2 Data Types

```
Question {
  id:          string
  text:        string            (user-facing question)
  category:    string            (e.g., "composition", "lighting", "brand")
  type:        "free" | "choice" | "multi" | "scale" | "image"
  options:     string[] | null   (for choice/multi types)
  phase:       int               (which phase of the interview)
}

Answer {
  questionID:  string
  value:       any
  confidence:  float (0-1)
}

Ambiguity {
  field:       string
  reason:      string
  alternatives: string[]
}

InterviewResult {
  intents:     Intent[]
  facts:       Fact[]
  constraints: Constraint[]
  confidence:  float
}
```

### 8.3 Phases

| Phase | Focus | Questions |
|-------|-------|-----------|
| 1 | Product/Category | What is being designed? |
| 2 | Style & Mood | Visual direction |
| 3 | Technical | Format, model, resolution |
| 4 | Brand | Brand guidelines (if applicable) |

### 8.4 Invariants

- **I-001 — User-Friendly.** Questions MUST be formulated in natural, human language — NOT technical terms.
- **I-002 — Progressive.** Each phase builds on the previous one. No forward references.
- **I-003 — Abortable.** The user MUST be able to cancel the interview at any point.

---

## 9. Reasoning Protocol

The Reasoning protocol defines how the LLM is invoked with controlled context.

### 9.1 Contract

```
interface Reasoning {
  name:     string
  provider: string               (e.g., "openrouter", "anthropic")
  model:    string               (e.g., "deepseek-v4-flash")

  infer(
    prompt:       string         (the task)
    context:      Context        (structured context from the Canonical Model)
    constraints:  string[]       (what the LLM must follow)
    maxTokens:    int
    temperature:  float
  ) → InferenceResult
}
```

### 9.2 Input

```
Context {
  project:     ProjectModel     (current state)
  knowledge:   Fact[]           (relevant facts from Knowledge Providers)
  memory:      MemoryEntry[]    (relevant past memories)
  instructions: string          (system prompt — how to reason)
}
```

### 9.3 Response

```
InferenceResult {
  output:       string           (LLM's raw response)
  parsed:       ParsedOutput     (structured if parseable)
  proposals:    Proposal[]       (node/edge proposals extracted from output)
  tokens:       { input: int, output: int }
  duration:     int              (ms)
  model:        string           (actual model used)
}
```

### 9.4 Invariants

- **L-001 — LLM Proposes, Kernel Decides.** The Reasoning engine MUST NOT apply changes to the Canonical Model. It returns Proposals.
- **L-002 — Controlled Context.** The Reasoning engine MUST only receive context that is explicitly passed. No hidden state.
- **L-003 — Retry on Parse Failure.** If the LLM's response cannot be parsed into structured proposals, the Reasoning engine MUST retry (up to 3 attempts).

---

## 10. Learning Protocol

**Purpose:** Define how the Learning Engine stores and retrieves patterns.

| Aspect | Specification |
|--------|:-------------:|
| **Contract** | `LearningEngine.extract_patterns(project_ids) → Pattern[]` |
| **Input** | List of completed Project IDs |
| **Output** | Array of patterns: `{domain, field, value, confidence, count}` |
| **Storage** | KnowledgeRegistry under namespace `patterns.{domain}` |

### 10.1 Contract

```
LearningEngine:
  extract_patterns(project_ids: list[UUID]) → list[Pattern]
  suggest_next(project_graph: Graph) → list[Suggestion]
  approve_pattern(pattern_id: UUID) → bool
  reject_pattern(pattern_id: UUID) → bool
```

### 10.2 Pattern Format

```yaml
pattern:
  id: uuid
  domain: "photography" | "film" | "advertising"
  field: "lighting" | "lens" | "composition" | "color_palette"
  recommended_value: "golden_hour" | "85mm_f1.4" | ...
  confidence: 0.0-1.0          # based on consistency of past decisions
  evidence_count: int           # how many past decisions support this
  source_projects: [uuid, ...]  # projects that contributed evidence
  created_at: datetime
  status: "candidate" | "approved" | "rejected"
```

### 10.3 Invariants

- **LRN-001 — Non-destructive.** Learning never modifies existing project data.
- **LRN-002 — Explicit opt-in.** Patterns are suggested, never automatically applied.
- **LRN-003 — Decay.** Patterns with < evidence_count threshold are auto-removed.
- **LRN-004 — Domain isolation.** Patterns are stored per-domain, never mixed.

### 10.4 Implementation Status

- ✅ MemoryStore exists (Phase 4B)
- ❌ LearningEngine exists (Phase 5)

---

## 11. Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Orchestrator                          │
│  (decides which transformers to run, in which order)     │
└──────────┬──────────────┬──────────────┬────────────────┘
           │              │              │
    ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐
    │ Transformer │ │ Knowledge  │ │ Renderer   │
    │ Protocol    │ │ Provider   │ │ Protocol   │
    └──────┬──────┘ │ Protocol   │ └─────┬──────┘
           │        └─────┬──────┘       │
           │              │              │
    ┌──────▼──────────────▼──────────────▼──────┐
    │            Canonical Model                 │
    │       (Registry + ProjectModel)            │
    └──────────────────┬────────────────────────┘
                       │
              ┌────────▼────────┐
              │   Memory        │
              │   Protocol      │
              └─────────────────┘

    External:
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │ LLM API    │  │ User       │  │ Generation │
    │ (Reasoning)│  │ (Interview)│  │ API        │
    └────────────┘  └────────────┘  └────────────┘
```

---

## 11. Compliance

An implementation is CP-001 compliant if:

1. Every Transformer implements the `transform(model, context) → result` contract
2. Every Knowledge Provider implements the `query(request) → result` contract
3. Every Renderer implements the `render(blueprint, context) → result` contract
4. Memory implements `store/read/search/delete/clear` with namespace isolation
5. Interview implements `start/ask/collect/clarify/abort` with phases
6. Reasoning implements `infer(prompt, context) → proposals` with retry
7. No component bypasses the contract to access the Canonical Model directly

---

## 12. Change Policy

### Minor Version
Permitted:
- Addition of new protocol fields (with backward compatibility)
- New adapters for existing protocols
- Clarification of contract semantics

### Major Version
Permitted:
- Changes to existing protocol signatures
- Removal or redesign of a protocol
- Changes to compliance requirements

---

*End of CP-001 Specification*