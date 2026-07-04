# CM-001 — Examples

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## Example 1: Minimal Project — "Ad for Porsche in Pixar Style"

### Source

```json
{
  "id": "018f-1111-aaaa-bbbb-cccccccccccc",
  "type": "Source",
  "state": "approved",
  "properties": {
    "rawType": "text",
    "content": "Ad for Porsche in Pixar style",
    "format": "text/plain",
    "language": "en"
  },
  "metadata": {
    "createdAt": "2026-06-29T10:00:00Z",
    "author": { "id": "user-vitaliy", "type": "human", "name": "Vitaliy" }
  }
}
```

### Intent

```json
{
  "id": "018f-1111-cccc-dddd-eeeeeeeeeeee",
  "type": "Intent",
  "state": "approved",
  "properties": {
    "description": "Create a promotional image of a Porsche 911 in Pixar animation style",
    "confidence": 0.92,
    "sourceID": "018f-1111-aaaa-bbbb-cccccccccccc",
    "language": "en"
  },
  "metadata": {
    "createdAt": "2026-06-29T10:00:05Z",
    "author": { "id": "llm-deepseek", "type": "llm", "name": "DeepSeek V4 Flash" },
    "provenance": {
      "method": "llm-inference",
      "sourceIDs": ["018f-1111-aaaa-bbbb-cccccccccccc"]
    }
  }
}
```

### Goal

```json
{
  "id": "018f-2222-aaaa-bbbb-cccccccccccc",
  "type": "Goal",
  "state": "approved",
  "properties": {
    "description": "Generate a single high-quality image of a Porsche 911 rendered in Pixar style",
    "priority": "primary",
    "criteria": ["Porsche 911 is recognizable", "Pixar aesthetic (smooth, stylized, colorful)", "Single image, landscape orientation"]
  },
  "metadata": {
    "createdAt": "2026-06-29T10:00:08Z",
    "author": { "id": "llm-deepseek", "type": "llm" }
  }
}
```

### Constraint

```json
{
  "id": "018f-2222-eeee-ffff-aaaaaaaaaaaa",
  "type": "Constraint",
  "state": "approved",
  "properties": {
    "description": "Must use realistic proportions of Porsche 911, not a caricature",
    "category": "stylistic",
    "strength": "hard"
  },
  "metadata": {
    "createdAt": "2026-06-29T10:00:08Z",
    "author": { "id": "llm-deepseek", "type": "llm" }
  }
}
```

### Decision

```json
{
  "id": "018f-3333-aaaa-bbbb-cccccccccccc",
  "type": "Decision",
  "state": "approved",
  "properties": {
    "description": "Use warm sunset lighting with soft shadows",
    "rationale": "Pixar style uses warm palettes and soft lighting",
    "alternatives": ["Studio lighting (cold)", "Overcast (moody)"]
  },
  "metadata": {
    "createdAt": "2026-06-29T10:00:12Z",
    "author": { "id": "llm-deepseek", "type": "llm" }
  }
}
```

### Blueprint

```json
{
  "id": "018f-4444-aaaa-bbbb-cccccccccccc",
  "type": "Blueprint",
  "state": "approved",
  "properties": {
    "description": "Porsche 911 Pixar cinematic shot",
    "specifications": [
      {"key": "composition", "value": "Low angle, car slightly off-center right, dynamic perspective"},
      {"key": "lighting", "value": "Warm golden hour, soft rim light, slight lens flare"},
      {"key": "colors", "value": "Red car, warm orange sky, blue gradient ground"},
      {"key": "background", "value": "Stylized desert road with cacti, Pixar-style clouds"}
    ],
    "modelType": "sdxl",
    "format": "prompt"
  },
  "metadata": {
    "createdAt": "2026-06-29T10:00:15Z",
    "author": { "id": "llm-deepseek", "type": "llm" }
  }
}
```

### Edges

```json
[
  {
    "id": "edge-001",
    "type": "derives_from",
    "source": "018f-1111-cccc-dddd-eeeeeeeeeeee",
    "target": "018f-1111-aaaa-bbbb-cccccccccccc",
    "properties": {},
    "metadata": { "createdAt": "2026-06-29T10:00:10Z" }
  },
  {
    "id": "edge-002",
    "type": "refines",
    "source": "018f-2222-aaaa-bbbb-cccccccccccc",
    "target": "018f-1111-cccc-dddd-eeeeeeeeeeee",
    "properties": {},
    "metadata": { "createdAt": "2026-06-29T10:00:10Z" }
  },
  {
    "id": "edge-003",
    "type": "constrains",
    "source": "018f-2222-eeee-ffff-aaaaaaaaaaaa",
    "target": "018f-3333-aaaa-bbbb-cccccccccccc",
    "properties": {},
    "metadata": { "createdAt": "2026-06-29T10:00:13Z" }
  },
  {
    "id": "edge-004",
    "type": "supports",
    "source": "018f-3333-aaaa-bbbb-cccccccccccc",
    "target": "018f-2222-aaaa-bbbb-cccccccccccc",
    "properties": {},
    "metadata": { "createdAt": "2026-06-29T10:00:13Z" }
  },
  {
    "id": "edge-005",
    "type": "satisfies",
    "source": "018f-4444-aaaa-bbbb-cccccccccccc",
    "target": "018f-3333-aaaa-bbbb-cccccccccccc",
    "properties": {},
    "metadata": { "createdAt": "2026-06-29T10:00:16Z" }
  }
]
```

### ProjectModel

```json
{
  "identity": { "id": "project-porsche-001", "version": 3 },
  "source": ["018f-1111-aaaa-bbbb-cccccccccccc"],
  "intents": ["018f-1111-cccc-dddd-eeeeeeeeeeee"],
  "goals": ["018f-2222-aaaa-bbbb-cccccccccccc"],
  "constraints": ["018f-2222-eeee-ffff-aaaaaaaaaaaa"],
  "facts": [],
  "decisions": ["018f-3333-aaaa-bbbb-cccccccccccc"],
  "blueprints": ["018f-4444-aaaa-bbbb-cccccccccccc"],
  "artifacts": [],
  "knowledge": [],
  "metadata": {
    "projectName": "Porsche Pixar Ad",
    "domain": ["photography", "advertising"],
    "modelTarget": "sdxl"
  },
  "history": ["snap-001", "snap-002", "snap-003"]
}
```

---

## Example 2: Graph Traversal — Finding Supports

**Query:** Given a Goal, find all Decisions that support it.

```python
goal_id = "018f-2222-aaaa-bbbb-cccccccccccc"

# Implementation in Hermes
edges = registry.get_edges(goal_id, "supported_by")
# Actually: we need edges where target == goal_id AND type == "supports"
# But edges have source → target direction, so:
# supports: source=Decision, target=Goal

edges = [
    edge for edge in registry.edges.values()
    if edge.type == "supports" and edge.target == goal_id
]

supporting_decisions = [registry.nodes[edge.source] for edge in edges]
```

---

## Example 3: Snapshot Chain — Version Evolution

```
Snapshot v1: Intent + Goal + Constraint
    │
    ▼  (LLM proposes Decision)
Snapshot v2: Intent + Goal + Constraint + Decision
    │
    ▼  (User adds Fact)
Snapshot v3: Intent + Goal + Constraint + Decision + Fact
    │
    ▼  (LLM proposes Blueprint)
Snapshot v4: Intent + Goal + Constraint + Decision + Fact + Blueprint
```

Each snapshot is a **complete copy** of the graph state at that point.

---

## Example 4: Branching — Alternative Approaches

```
Main ProjectModel: 
  Intent → Goal A → Decision "Warm lighting" → Blueprint v1
                                          
Fork at "Goal A" stage:

Branch 1: Goal A → Decision "Warm lighting" → Blueprint v1
Branch 2: Goal A → Decision "Cold studio" → Blueprint v2
```

Both branches share the same `Intent` and `Goal A` nodes (same IDs). Only `Decision` and `Blueprint` differ.

---

## Example 5: Domain Pack Extension — Product Photography

A Domain Pack for product photography adds:

```
Node types (Domain):
  ProductCategory: { name, type, material }
  LightingSetup: { key, fill, backlight }
  Composition: { angle, distance, lens }

Edge types (Domain):
  lights: LightingSetup → ProductCategory
  frames: Composition → ProductCategory
```

These extend, not replace, the core Node types from CO-001.

---

*End of Examples*