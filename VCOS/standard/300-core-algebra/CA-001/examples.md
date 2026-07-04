# CA-001 — Examples

**Part of:** [CA-001 — Core Algebra](../../300-core-algebra/CA-001/specification.md)

---

## Example 1: Full LLM → Kernel Cycle

### User Input
"Сделай фото кроссовок Nike Air Max на белом фоне в стиле минимализм."

### Step 1: LLM Proposes

```
Propose(
  proposal: {
    nodes: [
      {
        type: "Intent",
        properties: { description: "Product photo of Nike Air Max sneakers, white background, minimal style" }
      },
      {
        type: "Goal",
        properties: { description: "Single high-quality product shot", priority: "primary" }
      },
      {
        type: "Constraint",
        properties: { description: "White background", category: "stylistic", strength: "hard" }
      }
    ],
    edges: [
      { type: "derives_from", source: Intent, target: Source },
      { type: "refines", source: Goal, target: Intent },
      { type: "constrains", source: Constraint, target: Intent }
    ],
    justification: "Standard product photography flow: interpret intent, define goal, set constraints"
  },
  author: { type: "llm", name: "deepseek-v4" }
)
// → ProposalID: prop-001
```

### Step 2: Kernel Validates

```
Validate(graph) → []
// No violations — graph is valid
```

### Step 3: Kernel Decides to Accept

```
Decide(
  context: {
    goals: [prop-001.nodes[1].id],
    facts: [],
    constraints: [prop-001.nodes[2].id]
  },
  alternatives: [
    { description: "Studio lighting with gradient background", rejected_reason: "Budget constraint" },
    { description: "Lifestyle shot with model", rejected_reason: "Requires white background per brief" }
  ]
)
// → DecisionID: dec-001

// Then:
Accept(proposalID: "prop-001", rationale: "Matches user intent, all invariants satisfied")
// → 3 nodes created, 3 edges created, new snapshot
```

### Step 4: LLM Proposes Refinement

```
Propose(
  proposal: {
    nodes: [
      {
        type: "Decision",
        properties: {
          description: "Use 45-degree front lighting with soft shadows",
          rationale: "Minimal product photography standard",
          alternatives: ["Top-down flat lay", "Sidelight hard shadow"]
        }
      }
    ],
    edges: [
      { type: "supports", source: Decision, target: Goal },
      { type: "uses", source: Decision, target: Fact /* studio equipment */ }
    ]
  }
)
// → ProposalID: prop-002
```

### Step 5: Kernel Accepts

```
Accept(proposalID: "prop-002", rationale: "Standard product lighting approach")
// → Decision node created, edges created, new snapshot
```

---

## Example 2: Fork and Merge

### Scenario: Two design directions

```
Project "Nike-Ad" (ProjectID: proj-001)
  Snapshot chain: S1 → S2 → S3

// Director says: "Try two different lighting setups"

Fork(proj-001, S3, "Warm Lighting")
  → ProjectID: proj-001-branch-warm
  → First snapshot = copy of S3

Fork(proj-001, S3, "Cold Studio")
  → ProjectID: proj-001-branch-cold
  → First snapshot = copy of S3
```

Now two designers work in parallel on different branches.

```
// After some work:
// Branch "warm": S3 → S4w → S5w
// Branch "cold": S3 → S4c

// Merge "cold" back into main:
Merge(proj-001, proj-001-branch-cold, "fast-forward")
  → S6 on main (S3 → S4c → S6, same as branch)

// Merge "warm" with conflict resolution:
Merge(proj-001, proj-001-branch-warm, "three-way")
  → S7 on main (S6 → S7 with warm changes)
```

---

## Example 3: Rollback

```
// Before: S1 → S2 → S3 → S4 → S5
// S5 introduced a bad Decision

// Rollback to S3:
Rollback(proj-001, S3)

// After: S1 → S2 → S3 → S4 → S5 → S6
// S6 has the same state as S3
// S4 and S5 are still in the snapshot chain (history preserved)
// Decision Log records: "rollback to S3 at 2026-07-01T14:30:00Z by user-vitaliy"
```

---

## Example 4: Trace — Explaining a Decision

```
// Given a Blueprint node, find all decisions that led to it:
Trace(blueprint-001, direction: "backward")
  → [
      { type: "satisfies", source: blueprint-001, target: decision-003 },
      { type: "uses", source: decision-003, target: fact-012 },
      { type: "supports", source: decision-003, target: goal-001 },
      { type: "refines", source: goal-001, target: intent-001 },
      { type: "derives_from", source: intent-001, target: source-001 }
    ]

// Result: Full path from user input to final blueprint
// User typed "Nike Air Max photo" → Intent → Goal → Decision → Blueprint
```

---

## Example 5: Algebraic Properties in Action

```
// Commutativity: two independent proposals can be accepted in any order

Propose(A) → prop-A
Propose(B) → prop-B
Accept(prop-A); Accept(prop-B)  → Graph state = G1

// Reset and try in reverse:
Propose(A) → prop-A'
Propose(B) → prop-B'
Accept(prop-B'); Accept(prop-A')  → Graph state = G2

// Diff(G1, G2) → empty (same final state because A and B are independent)

// Non-commutative: dependent proposals
Propose(create Node X) → prop-X
Propose(create Edge from X to Y) → prop-Y
Accept(prop-Y) before Accept(prop-X) → FAILS (source X doesn't exist yet)
```

---

*End of Examples*