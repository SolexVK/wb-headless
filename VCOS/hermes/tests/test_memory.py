"""VCOS — Tests: Memory Protocol (Phase 4B)

Проверяет CP-001.4 Memory Protocol: store, read, search, delete, clear, namespaces.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.memory.memory import (
    MemoryStore, MemoryResult, validate_namespace, NAMESPACES
)


# ═══════════════════════════════════════════
# Validate namespace
# ═══════════════════════════════════════════

def test_validate_namespace_valid():
    """Валидные namespace'ы."""
    assert validate_namespace("user.preferences")
    assert validate_namespace("project.test-123.facts")
    assert validate_namespace("domain.photography")
    assert validate_namespace("system.v1.0")


def test_validate_namespace_invalid():
    """Невалидные namespace'ы."""
    assert not validate_namespace("custom")
    assert not validate_namespace("random.data")
    assert not validate_namespace("")


# ═══════════════════════════════════════════
# Store & Read
# ═══════════════════════════════════════════

def test_store_and_read():
    """Store → Read возвращает значение."""
    store = MemoryStore()
    store.store("last_project", "одежда-рубашка", "user.preferences")
    assert store.read("last_project", "user.preferences") == "одежда-рубашка"


def test_read_missing():
    """Read несуществующего ключа → None."""
    store = MemoryStore()
    assert store.read("nonexistent", "user.preferences") is None


def test_store_overwrite():
    """Store с существующим ключом перезаписывает."""
    store = MemoryStore()
    store.store("key", "old_value", "user.preferences")
    store.store("key", "new_value", "user.preferences")
    assert store.read("key", "user.preferences") == "new_value"


def test_store_invalid_namespace():
    """Store с невалидным namespace → ошибка."""
    store = MemoryStore()
    try:
        store.store("key", "value", "invalid.namespace")
        assert False, "Должна быть ошибка"
    except ValueError:
        pass


def test_store_isolation():
    """Разные namespace'ы изолированы (M-003)."""
    store = MemoryStore()
    store.store("key", "user_value", "user.preferences")
    store.store("key", "project_value", "project.test.facts")
    assert store.read("key", "user.preferences") == "user_value"
    assert store.read("key", "project.test.facts") == "project_value"


# ═══════════════════════════════════════════
# Search
# ═══════════════════════════════════════════

def test_search_finds_by_key():
    """Search находит по ключу."""
    store = MemoryStore()
    store.store("blue_shirt", "Рубашка синяя", "user.preferences")
    store.store("red_dress", "Платье красное", "user.preferences")

    results = store.search("blue", "user.preferences")
    assert len(results) == 1
    assert results[0].key == "blue_shirt"
    assert results[0].score >= 0.5


def test_search_finds_by_value():
    """Search находит по значению."""
    store = MemoryStore()
    store.store("project_1", "Синяя рубашка оверсайз", "user.preferences")

    results = store.search("рубашка", "user.preferences")
    assert len(results) >= 1


def test_search_namespace_isolation():
    """Search не выходит за пределы namespace (M-003)."""
    store = MemoryStore()
    store.store("key", "target_value", "user.preferences")
    store.store("key", "other_value", "domain.test")

    results = store.search("target", "domain.test")
    assert len(results) == 0  # нет в domain.test


def test_search_ordered_by_score():
    """Search сортирует по убыванию score."""
    store = MemoryStore()
    store.store("exact_match", "термин", "user.preferences")
    store.store("partial", "другой термин здесь", "user.preferences")

    results = store.search("термин", "user.preferences")
    assert len(results) >= 2
    assert results[0].score >= results[1].score


# ═══════════════════════════════════════════
# Delete & Clear
# ═══════════════════════════════════════════

def test_delete():
    """Delete удаляет запись."""
    store = MemoryStore()
    store.store("test_key", "test_value", "user.preferences")
    assert store.read("test_key", "user.preferences") is not None
    assert store.delete("test_key", "user.preferences") is True
    assert store.read("test_key", "user.preferences") is None


def test_delete_missing():
    """Delete несуществующей записи → False."""
    store = MemoryStore()
    assert store.delete("nonexistent", "user.preferences") is False


def test_clear_namespace():
    """Clear удаляет все записи в namespace."""
    store = MemoryStore()
    store.store("a", "1", "user.preferences")
    store.store("b", "2", "user.preferences")
    store.store("c", "3", "domain.test")

    count = store.clear("user.preferences")
    assert count == 2
    assert store.count("user.preferences") == 0
    assert store.count("domain.test") == 1  # не затронут


# ═══════════════════════════════════════════
# Utility methods
# ═══════════════════════════════════════════

def test_list_keys():
    """List keys возвращает ключи в namespace."""
    store = MemoryStore()
    store.store("a", "1", "user.preferences")
    store.store("b", "2", "user.preferences")
    keys = store.list_keys("user.preferences")
    assert "a" in keys
    assert "b" in keys


def test_count():
    """Count возвращает количество записей."""
    store = MemoryStore()
    assert store.count() == 0
    store.store("a", "1", "user.preferences")
    store.store("b", "2", "domain.test")
    assert store.count() == 2
    assert store.count("user.preferences") == 1
    assert store.count("domain.test") == 1


def test_get_namespaces():
    """Get namespaces возвращает префиксы."""
    store = MemoryStore()
    store.store("a", "1", "user.preferences")
    store.store("b", "2", "project.test.facts")
    ns = store.get_namespaces()
    assert "user" in ns
    assert "project" in ns


def test_memory_result_fields():
    """MemoryResult имеет все поля (CP-001.4.2)."""
    result = MemoryResult(key="test", value="val", score=0.8)
    assert result.key == "test"
    assert result.value == "val"
    assert result.score == 0.8
    assert "createdAt" in result.metadata
    assert "updatedAt" in result.metadata
    assert "agentID" in result.metadata


def test_summary():
    """MemoryStore.summary() — читаемая сводка."""
    store = MemoryStore()
    store.store("a", "1", "user.preferences")
    store.store("b", "2", "project.test.facts")
    summary = store.summary()
    assert summary["total_entries"] == 2
    assert len(summary["namespaces"]) == 2