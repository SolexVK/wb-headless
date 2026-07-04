# CP-001 — Examples

**Part of:** [CP-001 — Core Protocols](../../400-protocols/CP-001/specification.md)

---

## Example 1: Full Pipeline — User Input to Artifact

### Phase 1: Interview

```
User: "Сделай фото духов на белом фоне"

Interview.ask(phase=1) →
  [
    "Какой продукт?",
    "Какой стиль: минимализм, роскошь, натуральный?",
    "Нужен ли хрусталь/отражение на флаконе?"
  ]

User answers: "Хорошо, пусть будет Chanel №5, роскошный стиль, с отражением."
Interview.collect() →
  { intents: [Chanel №5, luxury, reflection], confidence: 0.85 }
```

### Phase 2: Transformer (DesignTransformer)

```
DesignTransformer.transform(model, context):
  1. context.knowledge.query("perfume-photography") →
     Facts: { "Perfume lighting: 45deg backlight", "Reflection: glass table" }
  2. context.reasoning.infer(
       prompt="Design a luxury perfume product shot",
       context={ phase1_results, knowledge_facts }
     ) →
     Proposals: [
       (CreateNode: Decision, "Use 45-degree backlight with soft fill"),
       (CreateNode: Decision, "Use mirrored glass surface for reflection"),
       (CreateNode: Constraint, "Font must match Chanel brand")
     ]
  3. return TransformResult(model=model.apply(proposals))
```

### Phase 3: Renderer

```
Renderer.render(
  blueprint=model.blueprint,
  context={
    targetFormat: "sdxl-prompt",
    targetModel: "sdxl",
    specifications: [
      "Perfume bottle, glass surface, reflection",
      "Luxury lighting, warm amber tones",
      "White gradient background"
    ]
  }
) → RenderResult {
  artifact: Artifact(
    content: "Luxury perfume product photography, Chanel No.5 bottle...",
    format: "sdxl-prompt",
    generator: "prompt-renderer-v1"
  )
}
```

---

## Example 2: Transformer Chain

```
1. InterviewTransformer: "What do you want?"
   → model.v2 (intents + constraints)

2. DesignTransformer: "Let me design based on that"
   → model.v3 (goals + decisions)

3. ValidationTransformer: "Check invariants"
   → model.v4 (validated)

4. CompileTransformer: "Render to prompts"
   → model.v5 (with artifacts)

5. ReviewTransformer: "Check with director profile"
   → model.v6 (reviewed)
```

---

## Example 3: Knowledge Provider — Photography Domain

```python
def query(request):
    if request.domain != "photography":
        return KnowledgeResult(facts=[])

    facts = []

    # Rule-based facts
    if request.context.get("projectType") == "product-photo":
        facts.append(Fact("Standard: f/8 for product sharpness"))
        facts.append(Fact("Standard: 100mm macro lens"))

    # LLM-augmented facts
    if request.context.get("freeText"):
        llm_facts = llm.infer("Extract photography requirements", request)
        facts.extend(llm_facts)

    return KnowledgeResult(
        facts=facts,
        confidence=0.9,
        source="photography-kb-v2"
    )
```

---

## Example 4: Reasoning with Retry

```
# First attempt — malformed JSON
InferenceResult { parsed: null, proposals: [] }
  → Retry (attempt 2/3)

# Second attempt — partial parse
InferenceResult { parsed: { decisions: [...], missing: "edges" }, proposals: [...] }
  → Retry with stricter instruction (attempt 3/3)

# Third attempt — success
InferenceResult { parsed: { decisions: [...], edges: [...] }, proposals: [...] }
  → Accept and apply
```

---

## Example 5: Memory Search

```python
# Before starting a new project, search for relevant past work:
memory.search(
    query="luxury perfume product photography",
    namespace="project.*",
    limit=5
) → [
    { key: "project-chanel-n5", score: 0.92, metadata: { createdAt: "2026-03-15" } },
    { key: "project-gucci-bloom", score: 0.78, metadata: { createdAt: "2026-01-20" } }
]

# Use past decisions as context:
context.memory = results
new_proposals = reasoning.infer(
    prompt="Design perfume shot, considering past projects",
    context={ current_project, past_projects: results }
)
```

---

*End of Examples*