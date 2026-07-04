"""VCOS — Memory Protocol v1 (CP-001.4)

Постоянное хранилище, сохраняющееся между сессиями проекта.

CP-001.4 Memory Protocol:
  - store(key, value, namespace) → void
  - read(key, namespace) → any | null
  - search(query, namespace, limit) → MemoryResult[]
  - delete(key, namespace) → void
  - clear(namespace) → void

Инварианты (CP-001.4.4):
  M-001 — Survives Sessions
  M-002 — Versioned (createdAt, updatedAt)
  M-003 — Namespace Isolation
"""

from dataclasses import dataclass, field
from typing import Any, Optional
from datetime import datetime, timezone
import re


# ═══════════════════════════════════════════
# Data types (CP-001.4.2)
# ═══════════════════════════════════════════

@dataclass
class MemoryResult:
    """Результат поиска по памяти (CP-001.4.2)."""
    key: str
    value: Any
    score: float  # 0.0 — 1.0, релевантность
    metadata: dict = field(default_factory=lambda: {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "agentID": "gelios",
    })


# ═══════════════════════════════════════════
# Namespace definitions (CP-001.4.3)
# ═══════════════════════════════════════════

NAMESPACES = {
    "user.preferences":   "Настройки пользователя и повторяющиеся паттерны",
    "project":            "Данные проектов: project.{id}.facts, project.{id}.decisions",
    "domain":             "Доменные знания: domain.{name}",
    "system":             "Системная конфигурация: system.{version}",
}


def validate_namespace(namespace: str) -> bool:
    """Проверить, что namespace корректен (CP-001.4.3)."""
    # Разрешённые префиксы
    prefixes = ["user.preferences", "project.", "domain.", "system."]
    return any(namespace.startswith(p) for p in prefixes)


# ═══════════════════════════════════════════
# InMemoryStore — встроенное хранилище
# ═══════════════════════════════════════════

@dataclass
class MemoryEntry:
    """Внутренняя запись памяти."""
    key: str
    value: Any
    namespace: str
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    agent_id: str = "gelios"


class MemoryStore:
    """In-memory реализация Memory Protocol (CP-001.4).

    Использование:
        store = MemoryStore()

        # Store
        store.store("last_project", "одежда-рубашка", "user.preferences")

        # Read
        val = store.read("last_project", "user.preferences")

        # Search
        results = store.search("рубашка", "user.preferences", 5)

        # Delete
        store.delete("last_project", "user.preferences")

        # Clear namespace
        store.clear("user.preferences")
    """

    def __init__(self):
        self._entries: list[MemoryEntry] = []

    # ─── Core operations (CP-001.4.1) ────────────────────────

    def store(self, key: str, value: Any, namespace: str) -> None:
        """Сохранить значение в памяти (M-001, M-003).

        Если запись с таким key+namespace уже есть — обновляется.
        """
        if not validate_namespace(namespace):
            raise ValueError(f"Invalid namespace: {namespace}. "
                             f"Must start with one of: user.preferences, project., domain., system.")

        # Найти существующую запись
        existing = self._find(key, namespace)

        if existing:
            existing.value = value
            existing.updated_at = datetime.now(timezone.utc).isoformat()
        else:
            self._entries.append(MemoryEntry(
                key=key,
                value=value,
                namespace=namespace,
            ))

    def read(self, key: str, namespace: str) -> Any | None:
        """Прочитать значение (M-001, M-003).

        Returns:
            Значение или None, если не найдено
        """
        entry = self._find(key, namespace)
        return entry.value if entry else None

    def search(self, query: str, namespace: str, limit: int = 10) -> list[MemoryResult]:
        """Поиск по ключам и значениям в namespace (M-003).

        Использует простое substring matching.
        Для семантического поиска — использовать pgvectormem адаптер.
        """
        query_lower = query.lower().strip()
        results = []

        for entry in self._entries:
            if entry.namespace != namespace:
                continue

            # Ищем в key и string value
            score = 0.0
            if query_lower in entry.key.lower():
                score = 0.8
            elif isinstance(entry.value, str) and query_lower in entry.value.lower():
                score = 0.6
            elif isinstance(entry.value, dict) and any(
                query_lower in str(v).lower() for v in entry.value.values()
            ):
                score = 0.4

            if score > 0:
                results.append(MemoryResult(
                    key=entry.key,
                    value=entry.value,
                    score=score,
                    metadata={
                        "createdAt": entry.created_at,
                        "updatedAt": entry.updated_at,
                        "agentID": entry.agent_id,
                    },
                ))

        # Сортировка по score (убывание)
        results.sort(key=lambda r: r.score, reverse=True)
        return results[:limit]

    def delete(self, key: str, namespace: str) -> bool:
        """Удалить запись (M-003)."""
        for i, entry in enumerate(self._entries):
            if entry.key == key and entry.namespace == namespace:
                self._entries.pop(i)
                return True
        return False

    def clear(self, namespace: str) -> int:
        """Очистить весь namespace (M-003).

        Returns:
            Количество удалённых записей
        """
        before = len(self._entries)
        self._entries = [e for e in self._entries if e.namespace != namespace]
        return before - len(self._entries)

    # ─── Query methods ───────────────────────────────────────

    def list_keys(self, namespace: str) -> list[str]:
        """Список всех ключей в namespace."""
        return [e.key for e in self._entries if e.namespace == namespace]

    def count(self, namespace: Optional[str] = None) -> int:
        """Количество записей (опционально — в namespace)."""
        if namespace:
            return len([e for e in self._entries if e.namespace == namespace])
        return len(self._entries)

    def get_namespaces(self) -> list[str]:
        """Список всех namespace'ов."""
        ns = set()
        for e in self._entries:
            # Базовый префикс
            prefix = e.namespace.split(".")[0] if "." in e.namespace else e.namespace
            ns.add(prefix)
        return sorted(ns)

    # ─── Internal ────────────────────────────────────────────

    def _find(self, key: str, namespace: str) -> Optional[MemoryEntry]:
        for entry in self._entries:
            if entry.key == key and entry.namespace == namespace:
                return entry
        return None

    def summary(self) -> dict:
        return {
            "total_entries": len(self._entries),
            "namespaces": self.get_namespaces(),
            "entries_per_namespace": {
                ns: self.count(ns)
                for ns in self.get_namespaces()
            },
        }