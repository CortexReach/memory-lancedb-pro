import json
import sys
import types
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[1] / "integrations" / "hermes" / "lancedb_pro"
sys.path.insert(0, str(PLUGIN / "scripts"))

from import_openclaw_lancedb import convert_row, main, openclaw_timestamp_to_seconds, parse_metadata  # noqa: E402


def test_importer_missing_source_fails_without_creating_source_or_target(tmp_path, monkeypatch):
    missing_source = tmp_path / "missing-source"
    target = tmp_path / "target"

    def fail_connect(path):  # pragma: no cover - should not be reached
        Path(path).mkdir(parents=True, exist_ok=True)
        raise AssertionError("lancedb.connect should not be called for a missing source")

    monkeypatch.setitem(sys.modules, "lancedb", types.SimpleNamespace(connect=fail_connect))
    monkeypatch.setenv("HERMES_MEMORY_JINA_API_KEY", "test-key")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "import_openclaw_lancedb.py",
            "--source",
            str(missing_source),
            "--target",
            str(target),
        ],
    )

    with pytest.raises(SystemExit) as excinfo:
        main()

    assert "Source LanceDB path does not exist" in str(excinfo.value)
    assert not missing_source.exists()
    assert not target.exists()


class _FakeSourceDb:
    def table_names(self):
        return ["other_table"]

    def open_table(self, table_name):  # pragma: no cover - should not be reached
        raise AssertionError(f"unexpected open_table({table_name!r})")


def test_importer_missing_source_table_fails_before_target_created(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    target = tmp_path / "target"
    connections = []

    def fake_connect(path):
        connections.append(Path(path))
        assert Path(path) == source
        return _FakeSourceDb()

    monkeypatch.setitem(sys.modules, "lancedb", types.SimpleNamespace(connect=fake_connect))
    monkeypatch.setenv("HERMES_MEMORY_JINA_API_KEY", "test-key")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "import_openclaw_lancedb.py",
            "--source",
            str(source),
            "--source-table",
            "memories",
            "--target",
            str(target),
        ],
    )

    with pytest.raises(SystemExit) as excinfo:
        main()

    assert "Source table 'memories' not found" in str(excinfo.value)
    assert connections == [source]
    assert not target.exists()


def test_parse_metadata_accepts_dict_json_string_and_raw_string():
    assert parse_metadata({"a": 1}) == {"a": 1}
    assert parse_metadata('{"a": 1}') == {"a": 1}
    assert parse_metadata("not json") == {"raw_metadata": "not json"}
    assert parse_metadata("") == {}


def test_openclaw_timestamp_ms_converts_to_hermes_seconds():
    assert openclaw_timestamp_to_seconds(1_700_000_000_123) == 1_700_000_000.123
    assert openclaw_timestamp_to_seconds("1700000000.5") == 1_700_000_000.5


def test_convert_openclaw_row_to_hermes_schema_preserves_originals():
    row = {
        "id": "openclaw-123",
        "text": "Legacy OpenClaw memory text",
        "vector": [9.0, 9.0, 9.0],
        "category": "preference",
        "scope": "project",
        "importance": 0.75,
        "timestamp": 1_700_000_000_123,
        "metadata": json.dumps({"existing": "value", "scope": "metadata-scope"}),
    }
    out = convert_row(row, [0.1, 0.2, 0.3], "jina-test-model")

    assert set(out) == {
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
    assert out["id"] != "openclaw-123"
    assert out["content"] == "Legacy OpenClaw memory text"
    assert out["vector"] == [0.1, 0.2, 0.3]
    assert out["category"] == "preference"
    assert out["scope"] == "project"
    assert out["source"] == "openclaw_migration"
    assert out["created_at"] == 1_700_000_000.123
    assert out["updated_at"] == 1_700_000_000.123
    assert out["importance"] == 0.75
    assert out["embedding_model"] == "jina-test-model"
    assert out["dimensions"] == 3
    assert out["session_id"] == "openclaw_migration"

    metadata = json.loads(out["metadata_json"])
    assert metadata["existing"] == "value"
    assert metadata["original_id"] == "openclaw-123"
    assert metadata["original_timestamp"] == 1_700_000_000_123
    assert metadata["original_category"] == "preference"
    assert metadata["original_scope"] == "project"
    assert metadata["original_importance"] == 0.75
    assert metadata["original_metadata"] == {"existing": "value", "scope": "metadata-scope"}


def test_convert_supports_target_table_named_memories_by_not_changing_row_schema():
    # Target table selection is a CLI/storage concern. Converted rows remain
    # Hermes schema even when the importer is run with --target-table memories.
    out = convert_row({"id": "1", "text": "hello", "timestamp": 1_700_000_000_000}, [1.0], "model")
    assert "content" in out
    assert "metadata_json" in out
    assert "text" not in out
    assert "timestamp" not in out
