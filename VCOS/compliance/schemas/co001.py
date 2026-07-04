# CO-001: Core Ontology — JSON Schema
# Spec: Architecture Invariants, CO-001 v1.0.0-draft (docs 150–192)
#
# Defines the canonical set of:
#   - NodeType  (4 primitives: SOURCE, INTENT, GOAL, CONSTRAINT, FACT)
#   - RelationType (5 primitives: depends_on, supports, contradicts, produces, references)
#   - Lifecycle (Draft → Validated → Approved → Archived)
#   - Constraints (Decision MUST depend on Goal, etc.)

CO_001_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vcos.dev/schemas/co001",
    "title": "VCOS CO-001: Core Ontology",
    "description": "Core Ontology — 4 primitives + 5 relations + lifecycle",

    "definitions": {
        "node_type": {
            "type": "string",
            "enum": [
                "source",
                "intent",
                "goal",
                "constraint",
                "fact",
            ],
            "description": "CO-001 Core Primitives. Decision is an OPERATION (CA-001), not a type. Artifact is RUNTIME, not ontology. CREATIVE_STRATEGY, NARRATIVE, VISUAL_LANGUAGE belong to Domain Packs.",
        },
        "relation_type": {
            "type": "string",
            "enum": [
                "depends_on",
                "supports",
                "contradicts",
                "produces",
                "references",
            ],
            "description": "CO-001 Core Relations. CONSTRAINS, CONTAINS, DERIVED_FROM, NARRATES, EXPRESSES belong to Domain Packs.",
        },
        "node_status": {
            "type": "string",
            "enum": [
                "draft",
                "validated",
                "approved",
                "archived",
            ],
            "description": "CO-001 Lifecycle. PROPOSED, REJECTED, DEPRECATED are non-standard extensions.",
        },
        "invariants": {
            "type": "object",
            "properties": {
                "decision_has_goal": {
                    "type": "boolean",
                    "const": True,
                    "description": "Every Decision MUST depend on at least one Goal (Rule 001)",
                },
                "artifact_has_blueprint": {
                    "type": "boolean",
                    "const": True,
                    "description": "Every Artifact MUST be produced by at least one Decision (Rule 003)",
                },
                "source_immutable": {
                    "type": "boolean",
                    "const": True,
                    "description": "Source is immutable after creation (PM-I009)",
                },
            },
            "required": ["decision_has_goal", "artifact_has_blueprint", "source_immutable"],
        },
    },
}
