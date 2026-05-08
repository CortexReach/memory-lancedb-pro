import json
import os
import sys
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[1] / "integrations" / "hermes" / "lancedb_pro"
HERMES_SRC = os.getenv("HERMES_SRC")
sys.path.insert(0, str(PLUGIN.parent))
if HERMES_SRC:
    sys.path.insert(0, str(Path(HERMES_SRC).expanduser()))

from lancedb_pro import LancedbProMemoryProvider  # noqa: E402


def test_manual_store_search_status_forced_json(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_FORCE_JSON", "true")
    monkeypatch.setenv("HERMES_MEMORY_EMBED_PROVIDER", "hash")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_PATH", str(tmp_path / "memory" / "lancedb-pro"))
    monkeypatch.delenv("HERMES_MEMORY_JINA_API_KEY", raising=False)
    monkeypatch.delenv("HERMES_MEMORY_LANCEDB_TABLE", raising=False)
    monkeypatch.delenv("HERMES_MEMORY_LANCEDB_SCHEMA", raising=False)

    provider = LancedbProMemoryProvider()
    provider.initialize("test-session", hermes_home=str(tmp_path), platform="cli")

    status = json.loads(provider.handle_tool_call("lancedb_pro_status", {}))
    assert status["ok"] is True
    assert status["backend"] == "json_fallback"
    assert status["schema"] == "hermes"
    assert status["table"] == "hermes_memories"
    assert status["count"] == 0
    assert status["embedding_model"] == "jina-embeddings-v5-text-small"
    assert status["dimensions"] == 1024

    stored = json.loads(
        provider.handle_tool_call(
            "lancedb_pro_store",
            {
                "content": "Hermes uses LanceDB for durable semantic memory",
                "category": "project",
                "scope": "test",
                "source": "pytest",
                "importance": 0.9,
                "metadata": {"tag": "smoke"},
            },
        )
    )
    assert stored["ok"] is True
    assert stored["id"]

    found = json.loads(provider.handle_tool_call("lancedb_pro_search", {"query": "durable LanceDB memory", "limit": 1}))
    assert found["ok"] is True
    assert found["results"]
    result = found["results"][0]
    assert result["id"] == stored["id"]
    assert result["category"] == "project"
    assert result["scope"] == "test"
    assert result["source"] == "pytest"
    assert result["importance"] == 0.9
    assert result["embedding_model"] == "hash-dev-1024"
    assert result["dimensions"] == 1024
    assert result["metadata"] == {"tag": "smoke"}

    prefetched = provider.prefetch("what memory backend does Hermes use?")
    assert "Relevant lancedb_pro memories" in prefetched

    forgotten = json.loads(provider.handle_tool_call("lancedb_pro_forget", {"id": stored["id"]}))
    assert forgotten["ok"] is True
    assert forgotten["deleted"] == 1


def test_table_override_still_stores_hermes_schema_forced_json(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_FORCE_JSON", "true")
    monkeypatch.setenv("HERMES_MEMORY_EMBED_PROVIDER", "hash")
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_SCHEMA", "openclaw")  # ignored legacy env; provider is Hermes-schema only.
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_TABLE", "memories")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_PATH", str(tmp_path / "memory" / "lancedb-pro"))
    monkeypatch.delenv("HERMES_MEMORY_JINA_API_KEY", raising=False)

    provider = LancedbProMemoryProvider()
    provider.initialize("table-override-session", hermes_home=str(tmp_path), platform="cli")

    status = json.loads(provider.handle_tool_call("lancedb_pro_status", {}))
    assert status["ok"] is True
    assert status["schema"] == "hermes"
    assert status["table"] == "memories"

    stored = json.loads(
        provider.handle_tool_call(
            "lancedb_pro_store",
            {
                "content": "Hermes schema can use the memories table name",
                "category": "migration",
                "scope": "project",
                "source": "pytest",
                "importance": 0.8,
                "metadata": {"tag": "table-override"},
            },
        )
    )
    assert stored["ok"] is True

    rows = [json.loads(line) for line in (tmp_path / "memory" / "lancedb-pro" / "memories.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    row = rows[0]
    assert set(row) == {
        "id",
        "content",
        "vector",
        "category",
        "scope",
        "source",
        "created_at",
        "updated_at",
        "importance",
        "embedding_model",
        "dimensions",
        "metadata_json",
        "session_id",
    }
    assert row["content"] == "Hermes schema can use the memories table name"
    assert row["source"] == "pytest"
    assert json.loads(row["metadata_json"]) == {"tag": "table-override"}


def test_forced_json_uses_table_specific_file_for_custom_table(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_FORCE_JSON", "true")
    monkeypatch.setenv("HERMES_MEMORY_EMBED_PROVIDER", "hash")
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_TABLE", "custom_table")
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_PATH", str(tmp_path / "memory" / "lancedb-pro"))
    monkeypatch.delenv("HERMES_MEMORY_JINA_API_KEY", raising=False)

    provider = LancedbProMemoryProvider()
    provider.initialize("custom-table-json-session", hermes_home=str(tmp_path), platform="cli")

    stored = json.loads(provider.handle_tool_call("lancedb_pro_store", {"content": "custom table json fallback"}))
    assert stored["ok"] is True

    store_path = tmp_path / "memory" / "lancedb-pro"
    assert (store_path / "custom_table.jsonl").exists()
    assert not (store_path / "memories.jsonl").exists()


def test_real_lancedb_table_override_uses_hermes_schema(tmp_path, monkeypatch):
    pytest.importorskip("lancedb")
    monkeypatch.delenv("HERMES_MEMORY_LANCEDB_FORCE_JSON", raising=False)
    monkeypatch.delenv("HERMES_MEMORY_JINA_API_KEY", raising=False)
    monkeypatch.setenv("HERMES_MEMORY_EMBED_PROVIDER", "hash")
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_SCHEMA", "openclaw")  # ignored legacy env; provider is Hermes-schema only.
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_TABLE", "memories")
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_PATH", str(tmp_path / "lancedb-real"))

    provider = LancedbProMemoryProvider()
    provider.initialize("real-hermes-session", hermes_home=str(tmp_path), platform="cli")

    status = json.loads(provider.handle_tool_call("lancedb_pro_status", {}))
    assert status["backend"] == "lancedb"
    assert status["schema"] == "hermes"
    assert status["table"] == "memories"

    stored = json.loads(provider.handle_tool_call("lancedb_pro_store", {"content": "real LanceDB Hermes schema", "metadata": {"tag": "real"}}))
    assert stored["ok"] is True

    import lancedb

    table = lancedb.connect(str(tmp_path / "lancedb-real")).open_table("memories")
    raw = table.to_arrow().to_pylist()[0]
    assert {"id", "content", "vector", "category", "scope", "source", "created_at", "updated_at", "importance", "embedding_model", "dimensions", "metadata_json", "session_id"}.issubset(raw)
    assert "text" not in raw
    assert "timestamp" not in raw
    assert raw["content"] == "real LanceDB Hermes schema"
    assert json.loads(raw["metadata_json"])["tag"] == "real"


def test_sync_turn_default_off(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_FORCE_JSON", "true")
    monkeypatch.setenv("HERMES_MEMORY_EMBED_PROVIDER", "hash")
    monkeypatch.delenv("HERMES_MEMORY_LANCEDB_SYNC_TURN", raising=False)
    monkeypatch.delenv("HERMES_MEMORY_LANCEDB_AUTO_CAPTURE", raising=False)

    provider = LancedbProMemoryProvider()
    provider.initialize("test-session", hermes_home=str(tmp_path), platform="cli")
    provider.sync_turn("hello", "world")

    status = json.loads(provider.handle_tool_call("lancedb_pro_status", {}))
    assert status["sync_turn_enabled"] is False
    assert status["count"] == 0


def test_import_via_hermes_user_plugin_loader(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_MEMORY_LANCEDB_FORCE_JSON", "true")
    monkeypatch.setenv("HERMES_MEMORY_EMBED_PROVIDER", "hash")
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir(parents=True)
    (plugins_dir / "lancedb_pro").symlink_to(PLUGIN, target_is_directory=True)

    pytest.importorskip("plugins.memory")
    from plugins.memory import load_memory_provider  # noqa: E402

    provider = load_memory_provider("lancedb_pro")
    assert provider is not None
    assert provider.name == "lancedb_pro"
    provider.initialize("loader-test", hermes_home=str(tmp_path), platform="cli")
    status = json.loads(provider.handle_tool_call("lancedb_pro_status", {}))
    assert status["ok"] is True


def test_remote_jina_tasks_are_sent(monkeypatch):
    import lancedb_pro.provider as provider_module

    calls = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"data": [{"embedding": [1.0] * 1024}]}

    class FakeRequests:
        @staticmethod
        def post(url, headers=None, json=None, timeout=None):
            calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
            return FakeResponse()

    monkeypatch.setattr(provider_module, "_requests", FakeRequests)
    monkeypatch.setenv("HERMES_MEMORY_JINA_API_KEY", "test-key")
    monkeypatch.setenv("HERMES_MEMORY_HASH_FALLBACK", "false")

    embedder = provider_module._Embedder()
    vector = embedder.embed("hello", task="retrieval.query")

    assert len(vector) == 1024
    assert calls[0]["json"]["task"] == "retrieval.query"
    assert calls[0]["json"]["model"] == "jina-embeddings-v5-text-small"
