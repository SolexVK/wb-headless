"""Conftest for compliance tests — shared fixtures."""

import sys
import os

# Корень проекта — родитель каталога compliance/, а не захардкоженный ~/VCOS.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)


def resolve_path(path: str) -> str:
    """Разрешить путь вида '~/VCOS/hermes/...' относительно корня проекта."""
    for prefix in ("~/VCOS/", "~/VCOS"):
        if path.startswith(prefix):
            rel = path[len(prefix):].lstrip("/")
            return os.path.join(PROJECT_ROOT, rel)
    return os.path.expanduser(path)


def get_core_module():
    """Lazy import — compliance tests check structure, not runtime."""
    from hermes.kernel import core
    return core


def get_node_types():
    """Return the set of NodeType names from core.py."""
    from hermes.kernel.core import NodeType
    return {t.name for t in NodeType}


def get_relation_types():
    """Return the set of RelationType names from core.py."""
    from hermes.kernel.core import RelationType
    return {t.name for t in RelationType}


def get_node_statuses():
    """Return the set of lifecycle state names from core.py."""
    from hermes.kernel.core import LifecycleState
    return {t.name for t in LifecycleState}


def has_module(path: str) -> bool:
    """Check if a module file exists (paths relative to project root)."""
    return os.path.isfile(resolve_path(path))
