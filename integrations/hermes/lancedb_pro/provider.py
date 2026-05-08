"""Hermes-native LanceDB memory provider for memory-lancedb-pro.

Design goals:
- no Hermes core changes;
- no OpenClaw DB access;
- LanceDB when installed, deterministic hash embeddings for offline tests/dev;
- explicit manual tools: status/store/search/forget(single-id only);
- sync_turn writes are disabled unless opted in via env.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

try:
    from agent.memory_provider import MemoryProvider as _HermesMemoryProvider
except Exception:  # pragma: no cover - allows local import outside Hermes.
    class _HermesMemoryProvider:  # type: ignore[no-redef]
        pass

try:
    import requests as _requests
except Exception:  # pragma: no cover - requests is optional in minimal installs.
    _requests = None

DEFAULT_EMBED_MODEL = "jina-embeddings-v5-text-small"
DEFAULT_EMBED_DIM = 1024
DEFAULT_TABLE = "hermes_memories"


def _json_result(**payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _safe_table_file_stem(table_name: str) -> str:
    """Return a filesystem-safe JSON fallback file stem for a LanceDB table name."""
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in table_name.strip())
    cleaned = cleaned.strip("._-")
    return cleaned or DEFAULT_TABLE


def _safe_metadata(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    try:
        json.dumps(value, ensure_ascii=False)
        return dict(value)
    except Exception:
        return {str(k): str(v) for k, v in value.items()}


def _metadata_str(meta: Dict[str, Any], key: str, default: str = "") -> str:
    value = meta.get(key, default)
    return str(value) if value is not None else default


def _metadata_float(meta: Dict[str, Any], key: str, default: float) -> float:
    try:
        return float(meta.get(key, default))
    except Exception:
        return default


def _metadata_json(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return _safe_metadata(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return _safe_metadata(parsed)
    return {}


def _tokenize(text: str) -> List[str]:
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in text)
    return cleaned.split()


def _normalize(vec: Sequence[float]) -> List[float]:
    norm = math.sqrt(sum(float(x) * float(x) for x in vec)) or 1.0
    return [float(x) / norm for x in vec]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b:
        return 0.0
    return float(sum(float(x) * float(y) for x, y in zip(a, b)))


class _Embedder:
    """Jina/OpenAI-compatible embeddings with deterministic hash fallback.

    Hash mode is intentionally not production quality; it exists so tests and
    first-run validation can run without secrets or network access.
    """

    def __init__(self) -> None:
        self.dim = int(os.getenv("HERMES_MEMORY_EMBED_DIM", str(DEFAULT_EMBED_DIM)))
        self.provider = os.getenv("HERMES_MEMORY_EMBED_PROVIDER", "jina").strip().lower()
        self.api_key = os.getenv("HERMES_MEMORY_JINA_API_KEY") or ""
        self.base_url = os.getenv("HERMES_MEMORY_EMBED_BASE_URL", "https://api.jina.ai/v1/embeddings")
        self.model = os.getenv("HERMES_MEMORY_EMBED_MODEL", DEFAULT_EMBED_MODEL)
        self.timeout = float(os.getenv("HERMES_MEMORY_EMBED_TIMEOUT", "20"))
        self.allow_hash_fallback = _env_bool("HERMES_MEMORY_HASH_FALLBACK", True)

    @property
    def mode(self) -> str:
        if self.provider == "hash" or not self.api_key:
            return "hash"
        return self.provider

    def embed(self, text: str, *, task: str = "") -> List[float]:
        if self.mode != "hash":
            try:
                return self._remote_embed(text, task=task)
            except Exception:
                if not self.allow_hash_fallback:
                    raise
        return self._hash_embed(text)

    def _remote_embed(self, text: str, *, task: str = "") -> List[float]:
        payload_obj = {"model": self.model, "input": [text]}
        task_name = task or os.getenv("HERMES_MEMORY_EMBED_TASK", "")
        if task_name:
            payload_obj["task"] = task_name
        if _requests is not None:
            try:
                response = _requests.post(
                    self.base_url,
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    json=payload_obj,
                    timeout=self.timeout,
                )
                if response.status_code != 200:
                    raise RuntimeError(f"embedding endpoint returned HTTP {response.status_code}")
                return self._extract_remote_vector(response.json())
            except RuntimeError:
                raise
            except Exception:
                if not self.allow_hash_fallback:
                    raise
        payload = json.dumps(payload_obj, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url,
            data=payload,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # nosec - configured endpoint
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"embedding endpoint returned HTTP {exc.code}") from exc
        return self._extract_remote_vector(body)

    def _extract_remote_vector(self, body: Dict[str, Any]) -> List[float]:
        data = body.get("data") or []
        if not data or "embedding" not in data[0]:
            raise RuntimeError("embedding response missing data[0].embedding")
        vector = [float(x) for x in data[0]["embedding"]]
        self.dim = len(vector)
        return _normalize(vector)

    def _hash_embed(self, text: str) -> List[float]:
        vec = [0.0] * self.dim
        tokens = _tokenize(text) or [text or "empty"]
        for token in tokens:
            digest = hashlib.blake2b(token.encode("utf-8", "ignore"), digest_size=16).digest()
            idx = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[idx] += sign
        return _normalize(vec)


class _JsonMemoryStore:
    backend = "json_fallback"

    def __init__(self, path: Path, table_name: str) -> None:
        self.path = path
        self.table_name = table_name
        self.file = path / f"{_safe_table_file_stem(table_name)}.jsonl"
        self.path.mkdir(parents=True, exist_ok=True)

    def add(self, row: Dict[str, Any]) -> None:
        with self.file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    def search(self, vector: Sequence[float], limit: int) -> List[Dict[str, Any]]:
        rows = self._rows()
        for row in rows:
            row["score"] = _cosine(vector, row.get("vector") or [])
        rows.sort(key=lambda item: item.get("score", 0.0), reverse=True)
        return rows[:limit]

    def delete(self, memory_id: str) -> int:
        rows = self._rows()
        kept = [row for row in rows if row.get("id") != memory_id]
        if len(kept) == len(rows):
            return 0
        with self.file.open("w", encoding="utf-8") as handle:
            for row in kept:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        return len(rows) - len(kept)

    def count(self) -> int:
        return len(self._rows())

    def _rows(self) -> List[Dict[str, Any]]:
        if not self.file.exists():
            return []
        rows: List[Dict[str, Any]] = []
        with self.file.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
        return rows


class _LanceMemoryStore:
    backend = "lancedb"

    def __init__(self, path: Path, table_name: str) -> None:
        import lancedb

        self.path = path
        self.table_name = table_name
        self.path.mkdir(parents=True, exist_ok=True)
        self.db = lancedb.connect(str(path))
        try:
            self.table = self.db.open_table(table_name)
        except Exception:
            self.table = None

    def add(self, row: Dict[str, Any]) -> None:
        lance_row = dict(row)
        if self.table is None:
            self.table = self.db.create_table(self.table_name, data=[lance_row])
        else:
            self.table.add([lance_row])

    def search(self, vector: Sequence[float], limit: int) -> List[Dict[str, Any]]:
        if self.table is None:
            return []
        rows = self.table.search(list(vector)).limit(limit).to_list()
        return [self._decode(row) for row in rows]

    def delete(self, memory_id: str) -> int:
        if self.table is None:
            return 0
        before = self.count()
        escaped = memory_id.replace("'", "''")
        self.table.delete(f"id = '{escaped}'")
        return max(0, before - self.count())

    def count(self) -> int:
        if self.table is None:
            return 0
        try:
            return int(self.table.count_rows())
        except Exception:
            return len(self.table.to_list())

    def _decode(self, row: Dict[str, Any]) -> Dict[str, Any]:
        decoded = dict(row)
        if "metadata_json" in decoded:
            decoded["metadata"] = _metadata_json(decoded.get("metadata_json"))
        elif "metadata" in decoded:
            decoded["metadata"] = _metadata_json(decoded.get("metadata"))
        if "_distance" in decoded and "score" not in decoded:
            decoded["score"] = 1.0 / (1.0 + float(decoded.get("_distance") or 0.0))
        return decoded


STORE_SCHEMA: Dict[str, Any] = {
    "name": "lancedb_pro_store",
    "description": "Store a durable memory in the Hermes lancedb_pro memory provider.",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "Memory text to store."},
            "category": {"type": "string", "description": "Optional category, e.g. preference/project/fact."},
            "scope": {"type": "string", "description": "Optional scope, e.g. global/user/project/session."},
            "source": {"type": "string", "description": "Optional source marker."},
            "importance": {"type": "number", "description": "Optional importance from 0.0 to 1.0."},
            "metadata": {"type": "object", "description": "Optional JSON metadata.", "additionalProperties": True},
        },
        "required": ["content"],
    },
}

SEARCH_SCHEMA: Dict[str, Any] = {
    "name": "lancedb_pro_search",
    "description": "Search stored Hermes lancedb_pro memories by semantic similarity.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query."},
            "limit": {"type": "integer", "description": "Maximum number of results.", "default": 5},
        },
        "required": ["query"],
    },
}

STATUS_SCHEMA: Dict[str, Any] = {
    "name": "lancedb_pro_status",
    "description": "Return provider status, backend, storage path, and memory count.",
    "parameters": {"type": "object", "properties": {}},
}

FORGET_SCHEMA: Dict[str, Any] = {
    "name": "lancedb_pro_forget",
    "description": "Delete one lancedb_pro memory by exact id only.",
    "parameters": {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "Memory id returned by store/search."}},
        "required": ["id"],
    },
}


class LancedbProMemoryProvider(_HermesMemoryProvider):
    @property
    def name(self) -> str:
        return "lancedb_pro"

    def __init__(self) -> None:
        self._session_id = ""
        self._hermes_home = Path(os.path.expanduser(os.getenv("HERMES_HOME", "~/.hermes")))
        configured_path = os.getenv("HERMES_MEMORY_LANCEDB_PATH")
        self._store_path = Path(os.path.expanduser(configured_path)) if configured_path else None
        self._table_name = os.getenv("HERMES_MEMORY_LANCEDB_TABLE", DEFAULT_TABLE)
        self._embedder = _Embedder()
        self._store: Optional[Any] = None
        self._last_prefetch = ""
        self._sync_turn_enabled = _env_bool("HERMES_MEMORY_LANCEDB_SYNC_TURN", False) or _env_bool(
            "HERMES_MEMORY_LANCEDB_AUTO_CAPTURE", False
        )
        self._auto_recall_enabled = _env_bool("HERMES_MEMORY_LANCEDB_AUTO_RECALL", True)
        self._last_backend_error = ""

    def is_available(self) -> bool:
        return True

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id or "default"
        hermes_home = kwargs.get("hermes_home") or os.getenv("HERMES_HOME")
        if hermes_home:
            self._hermes_home = Path(str(hermes_home)).expanduser()
        if self._store_path is None:
            self._store_path = self._hermes_home / "memory" / "lancedb-pro"
        self._store = self._open_store(self._store_path)

    def _open_store(self, path: Path) -> Any:
        force_json = _env_bool("HERMES_MEMORY_LANCEDB_FORCE_JSON", False)
        if not force_json:
            try:
                return _LanceMemoryStore(path, self._table_name)
            except Exception as exc:
                self._last_backend_error = f"lancedb unavailable: {exc.__class__.__name__}"
        return _JsonMemoryStore(path, self._table_name)

    def system_prompt_block(self) -> str:
        backend = getattr(self._store, "backend", "not_initialized")
        return (
            "Hermes lancedb_pro memory provider is active. "
            "Use lancedb_pro_store for durable user/project facts and lancedb_pro_search for recall. "
            f"Backend: {backend}. sync_turn auto-capture is disabled unless explicitly enabled."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._auto_recall_enabled or not query.strip():
            return ""
        limit = max(1, min(int(os.getenv("HERMES_MEMORY_LANCEDB_PREFETCH_LIMIT", "3")), 10))
        results = self._search(query, limit=limit)
        if not results:
            return ""
        lines = ["Relevant lancedb_pro memories:"]
        for row in results:
            score = row.get("score")
            suffix = f" (score={score:.3f})" if isinstance(score, (float, int)) else ""
            lines.append(f"- {row.get('content', '')}{suffix}")
        self._last_prefetch = "\n".join(lines)
        return self._last_prefetch

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        if not self._sync_turn_enabled:
            return
        content = f"User: {user_content}\nAssistant: {assistant_content}".strip()
        if content:
            self._store_memory(content, {"category": "conversation", "scope": "session", "source": "sync_turn", "session_id": session_id or self._session_id})

    def on_memory_write(self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        if action in {"add", "replace"} and content:
            merged = {"category": target or "memory", "scope": "global", "source": "builtin_memory"}
            merged.update(metadata or {})
            self._store_memory(content, merged)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [STORE_SCHEMA, SEARCH_SCHEMA, STATUS_SCHEMA, FORGET_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        args = args or {}
        if tool_name == "lancedb_pro_store":
            content = str(args.get("content") or "").strip()
            if not content:
                return _json_result(ok=False, error="content is required")
            metadata = _safe_metadata(args.get("metadata"))
            for key in ("category", "scope", "source", "importance"):
                if key in args and args[key] is not None:
                    metadata[key] = args[key]
            memory_id = self._store_memory(content, metadata)
            return _json_result(ok=True, id=memory_id, backend=self._backend_name())
        if tool_name == "lancedb_pro_search":
            query = str(args.get("query") or "").strip()
            if not query:
                return _json_result(ok=False, error="query is required")
            limit = max(1, min(int(args.get("limit") or 5), 20))
            return _json_result(ok=True, results=self._search(query, limit), backend=self._backend_name())
        if tool_name == "lancedb_pro_status":
            return _json_result(ok=True, **self._status())
        if tool_name == "lancedb_pro_forget":
            memory_id = str(args.get("id") or "").strip()
            if not memory_id:
                return _json_result(ok=False, error="id is required")
            deleted = self._ensure_store().delete(memory_id)
            return _json_result(ok=True, deleted=deleted, id=memory_id)
        return _json_result(ok=False, error=f"unknown tool: {tool_name}")

    def shutdown(self) -> None:
        self._store = None

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "jina_api_key",
                "description": "Jina/OpenAI-compatible embeddings API key. Optional; hash fallback works offline.",
                "secret": True,
                "required": False,
                "env_var": "HERMES_MEMORY_JINA_API_KEY",
            },
            {
                "key": "store_path",
                "description": "LanceDB directory. Defaults to $HERMES_HOME/memory/lancedb-pro.",
                "required": False,
                "env_var": "HERMES_MEMORY_LANCEDB_PATH",
            },
            {
                "key": "table",
                "description": "LanceDB table name. Defaults to hermes_memories. The table always stores Hermes-schema rows.",
                "required": False,
                "env_var": "HERMES_MEMORY_LANCEDB_TABLE",
            },
        ]

    def _ensure_store(self) -> Any:
        if self._store is None:
            base = self._store_path or (self._hermes_home / "memory" / "lancedb-pro")
            self._store = self._open_store(base)
        return self._store

    def _store_memory(self, content: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        meta = _safe_metadata(metadata)
        category = _metadata_str(meta, "category", "memory")
        scope = _metadata_str(meta, "scope", "global")
        source = _metadata_str(meta, "source", "manual")
        importance = _metadata_float(meta, "importance", 0.5)
        extra_meta = {k: v for k, v in meta.items() if k not in {"category", "scope", "source", "importance"}}
        vector = self._embedder.embed(content, task=os.getenv("HERMES_MEMORY_EMBED_PASSAGE_TASK", "retrieval.passage"))
        memory_id = str(uuid.uuid4())
        now = time.time()
        embedding_model = self._embedder.model if self._embedder.mode != "hash" else f"hash-dev-{self._embedder.dim}"
        row = {
            "id": memory_id,
            "content": content,
            "vector": vector,
            "category": category,
            "scope": scope,
            "source": source,
            "created_at": now,
            "updated_at": now,
            "importance": importance,
            "embedding_model": embedding_model,
            "dimensions": len(vector),
            "metadata_json": json.dumps(extra_meta, ensure_ascii=False, sort_keys=True),
            "session_id": self._session_id,
        }
        self._ensure_store().add(row)
        return memory_id

    def _search(self, query: str, limit: int) -> List[Dict[str, Any]]:
        vector = self._embedder.embed(query, task=os.getenv("HERMES_MEMORY_EMBED_QUERY_TASK", "retrieval.query"))
        rows = self._ensure_store().search(vector, limit)
        clean: List[Dict[str, Any]] = []
        for row in rows:
            metadata = row.get("metadata")
            if metadata is None and "metadata_json" in row:
                metadata = row.get("metadata_json")
            metadata = _metadata_json(metadata)
            content = row.get("content") if row.get("content") is not None else row.get("text", "")
            timestamp = row.get("timestamp")
            created_at = row.get("created_at", metadata.get("created_at", timestamp))
            updated_at = row.get("updated_at", metadata.get("updated_at", timestamp))
            clean.append(
                {
                    "id": row.get("id"),
                    "content": content,
                    "score": row.get("score"),
                    "category": row.get("category", ""),
                    "scope": row.get("scope", ""),
                    "source": row.get("source", metadata.get("source", "")),
                    "created_at": created_at,
                    "updated_at": updated_at,
                    "importance": row.get("importance"),
                    "embedding_model": row.get("embedding_model", metadata.get("embedding_model")),
                    "dimensions": row.get("dimensions", metadata.get("dimensions", len(row.get("vector") or []))),
                    "metadata": metadata,
                    "session_id": row.get("session_id", metadata.get("session_id", "")),
                }
            )
        return clean

    def _backend_name(self) -> str:
        return getattr(self._ensure_store(), "backend", "unknown")

    def _status(self) -> Dict[str, Any]:
        store = self._ensure_store()
        return {
            "name": self.name,
            "backend": getattr(store, "backend", "unknown"),
            "path": str(self._store_path or ""),
            "schema": "hermes",
            "table": self._table_name,
            "count": int(store.count()),
            "embedding_mode": self._embedder.mode,
            "embedding_model": self._embedder.model,
            "dimensions": self._embedder.dim,
            "hash_fallback_note": "hash embeddings are deterministic dev/test fallback, not production semantic embeddings",
            "sync_turn_enabled": self._sync_turn_enabled,
            "auto_recall_enabled": self._auto_recall_enabled,
            "backend_error": self._last_backend_error,
        }


MemoryProvider = LancedbProMemoryProvider


def register(ctx: Any) -> None:
    ctx.register_memory_provider(LancedbProMemoryProvider())


def register_memory_provider() -> LancedbProMemoryProvider:
    return LancedbProMemoryProvider()
