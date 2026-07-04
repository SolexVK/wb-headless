# CM-001: Canonical Model — JSON Schema
# Spec: CM-001 v1.0.0-draft (docs 185–190)
#
# Semantic Graph = Node + Edge + Graph (3 fundamental objects)
# Nodes don't know about each other — edges live separately.
# Graph is the SINGLE source of truth.

CM_001_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vcos.dev/schemas/cm001",
    "title": "VCOS CM-001: Canonical Model (Semantic Graph)",
    "description": "Semantic Graph — Node, Edge, Graph as SSOT",

    "definitions": {
        "node": {
            "type": "object",
            "required": ["id", "type", "status", "properties", "metadata"],
            "properties": {
                "id": {"type": "string", "format": "uuid"},
                "type": {"$ref": "co001.json#/definitions/node_type"},
                "status": {"$ref": "co001.json#/definitions/node_status"},
                "properties": {
                    "type": "object",
                    "description": "Domain-specific properties. Kernel does NOT interpret them.",
                },
                "metadata": {
                    "type": "object",
                    "description": "Service info only. MUST NOT change semantics (PM-I008).",
                },
                "created_at": {"type": "string", "format": "date-time"},
                "updated_at": {"type": "string", "format": "date-time"},
            },
            "additionalProperties": False,
            "description": "Node is frozen (immutable). NEVER mutate in place — always replace.",
        },
        "edge": {
            "type": "object",
            "required": ["id", "source_id", "target_id", "relation"],
            "properties": {
                "id": {"type": "string", "format": "uuid"},
                "source_id": {"type": "string", "format": "uuid"},
                "target_id": {"type": "string", "format": "uuid"},
                "relation": {"$ref": "co001.json#/definitions/relation_type"},
                "properties": {
                    "type": "object",
                },
                "created_at": {"type": "string", "format": "date-time"},
            },
            "additionalProperties": False,
            "description": "Edges are independent. Nodes do NOT contain edges.",
        },
        "graph": {
            "type": "object",
            "required": ["nodes", "edges"],
            "properties": {
                "nodes": {
                    "type": "array",
                    "items": {"$ref": "#/definitions/node"},
                },
                "edges": {
                    "type": "array",
                    "items": {"$ref": "#/definitions/edge"},
                },
            },
            "additionalProperties": False,
            "description": "Graph is the SINGLE source of truth. NO parallel storage.",
        },
    },
}

# CM-001 invariants
CM001_GRAPH_INVARIANTS = {
    "G-001": "No cycles in the decision graph",
    "G-005": "Every node has at least one incoming or outgoing edge",
    "G-007": "Every Artifact references a Blueprint",
    "G-010": "Every Edge references existing Node IDs",
    "G-015": "Graph is the SINGLE storage — no Registry, no ProjectModel duplicates",
}
