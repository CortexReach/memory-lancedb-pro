#!/usr/bin/env python3
"""Safely import OpenClaw memory-lancedb-pro rows into Hermes lancedb_pro.

Safety defaults:
- source LanceDB is opened read-only-by-convention and never written;
- target path must be separate from the OpenClaw source;
- existing non-empty target tables are not overwritten unless --append is set;
- secrets are read from env/config but never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

DEFAULT_SOURCE = str(Path(os.getenv("OPENCLAW_HOME", "~/.openclaw")).expanduser() / "memory" / "lancedb-pro")
DEFAULT_SOURCE_TABLE = "memories"
DEFAULT_TARGET_TABLE = "hermes_memories"
DEFAULT_MODEL = "jina-embeddings-v5-text-small"
DEFAULT_BASE_URL = "https://api.jina.ai/v1"
DEFAULT_DIM = 1024


def eprint(*parts: Any) -> None:
    print(*parts, file=sys.stderr, flush=True)


def load_jina_config(path: str) -> Dict[str, Any]:
    cfg = {"api_key": os.getenv("HERMES_MEMORY_JINA_API_KEY") or os.getenv("JINA_API_KEY") or ""}
    if cfg["api_key"]:
        cfg.update({"source": "env", "model": os.getenv("HERMES_MEMORY_EMBED_MODEL", DEFAULT_MODEL), "base_url": os.getenv("HERMES_MEMORY_EMBED_BASE_URL", DEFAULT_BASE_URL).removesuffix("/embeddings")})
        return cfg
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return cfg

    found: Optional[Dict[str, Any]] = None

    def walk(obj: Any) -> None:
        nonlocal found
        if found is not None:
            return
        if isinstance(obj, dict):
            text = json.dumps(obj, ensure_ascii=False).lower()
            if "jina" in text and ("apikey" in "".join(obj.keys()).lower() or "apiKey" in obj):
                key = obj.get("apiKey") or obj.get("api_key") or obj.get("key")
                if key:
                    found = obj
                    return
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(data)
    if found:
        cfg.update({
            "api_key": found.get("apiKey") or found.get("api_key") or found.get("key") or "",
            "source": path,
            "model": found.get("model") or DEFAULT_MODEL,
            "base_url": (found.get("baseURL") or found.get("base_url") or DEFAULT_BASE_URL).removesuffix("/embeddings"),
        })
    return cfg


def chunks(items: List[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for idx in range(0, len(items), size):
        yield items[idx: idx + size]


def embed_batch(texts: List[str], *, api_key: str, base_url: str, model: str, task: str, timeout: int) -> List[List[float]]:
    import requests

    url = base_url.rstrip("/") + "/embeddings"
    response = requests.post(
        url,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
        json={"model": model, "input": texts, "task": task},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"embedding endpoint returned HTTP {response.status_code}")
    data = response.json().get("data") or []
    vectors = [row.get("embedding") for row in data]
    if len(vectors) != len(texts) or any(not isinstance(v, list) for v in vectors):
        raise RuntimeError("embedding response count/shape mismatch")
    return [[float(x) for x in v] for v in vectors]  # type: ignore[arg-type]


def parse_metadata(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {"raw_metadata": raw}
        except Exception:
            return {"raw_metadata": raw}
    return {}


def openclaw_timestamp_to_seconds(value: Any) -> float:
    """Convert OpenClaw Unix millisecond timestamps to Hermes Unix seconds."""
    try:
        created_f = float(value)
        if created_f > 10_000_000_000:  # ms -> seconds
            created_f = created_f / 1000.0
        return created_f
    except Exception:
        return time.time()


def convert_row(row: Dict[str, Any], vector: List[float], model: str) -> Dict[str, Any]:
    text = str(row.get("text") or row.get("content") or "").strip()
    original_metadata = parse_metadata(row.get("metadata"))
    metadata = dict(original_metadata)
    metadata.setdefault("original_id", str(row.get("id")) if row.get("id") is not None else None)
    metadata.setdefault("original_timestamp", row.get("timestamp"))
    metadata.setdefault("original_category", row.get("category"))
    metadata.setdefault("original_scope", row.get("scope"))
    metadata.setdefault("original_importance", row.get("importance"))
    metadata.setdefault("original_metadata", original_metadata)
    created_f = openclaw_timestamp_to_seconds(row.get("timestamp"))
    return {
        "id": str(uuid.uuid4()),
        "content": text,
        "vector": vector,
        "category": str(row.get("category") or metadata.get("category") or "memory"),
        "scope": str(row.get("scope") or metadata.get("scope") or "global"),
        "source": "openclaw_migration",
        "created_at": created_f,
        "updated_at": created_f,
        "importance": float(row.get("importance") if row.get("importance") is not None else metadata.get("importance", 0.5)),
        "embedding_model": model,
        "dimensions": len(vector),
        "metadata_json": json.dumps(metadata, ensure_ascii=False, sort_keys=True, default=str),
        "session_id": "openclaw_migration",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--source-table", default=DEFAULT_SOURCE_TABLE)
    parser.add_argument("--target", required=True)
    parser.add_argument("--target-table", default=DEFAULT_TARGET_TABLE)
    parser.add_argument("--config", default=str(Path(os.getenv("OPENCLAW_HOME", "~/.openclaw")).expanduser() / "openclaw.json"))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--progress-every", type=int, default=250)
    parser.add_argument("--append", action="store_true")
    parser.add_argument("--manifest", default="")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    target = Path(args.target).expanduser().resolve()
    if source == target:
        raise SystemExit("Refusing target inside/equal to OpenClaw source path")
    try:
        target.relative_to(source)
    except ValueError:
        pass
    else:
        raise SystemExit("Refusing target inside/equal to OpenClaw source path")
    if not source.exists():
        raise SystemExit(f"Source LanceDB path does not exist: {source}")
    if not source.is_dir():
        raise SystemExit(f"Source LanceDB path is not a directory: {source}")

    import lancedb

    src_db = lancedb.connect(str(source))
    try:
        source_tables = set(src_db.table_names())
    except Exception as exc:
        raise SystemExit(f"Unable to list source LanceDB tables in read-only preflight: {exc}") from exc
    if args.source_table not in source_tables:
        raise SystemExit(f"Source table {args.source_table!r} not found in {source}; available tables: {sorted(source_tables)}")
    try:
        src_table = src_db.open_table(args.source_table)
    except Exception as exc:
        raise SystemExit(f"Unable to open source table {args.source_table!r} during read-only preflight: {exc}") from exc

    cfg = load_jina_config(args.config)
    if not cfg.get("api_key"):
        raise SystemExit("Jina API key not found in env/config; refusing hash fallback migration")

    eprint("source", str(source), "table", args.source_table)
    eprint("target", str(target), "table", args.target_table)
    eprint("embedding", "provider=jina", "model=" + str(cfg.get("model", DEFAULT_MODEL)), "dims=" + str(DEFAULT_DIM), "key_present=True", "key_source=" + str(cfg.get("source", "unknown")))

    total = int(src_table.count_rows())
    arrow = src_table.to_arrow()
    if args.offset:
        arrow = arrow.slice(args.offset)
    if args.limit:
        arrow = arrow.slice(0, args.limit)
    rows = [r for r in arrow.to_pylist() if str(r.get("text") or r.get("content") or "").strip()]

    target.mkdir(parents=True, exist_ok=True)
    tgt_db = lancedb.connect(str(target))
    existing_tables = set(tgt_db.table_names())
    table = None
    if args.target_table in existing_tables:
        table = tgt_db.open_table(args.target_table)
        existing_count = int(table.count_rows())
        if existing_count and not args.append:
            raise SystemExit(f"Target table already has {existing_count} rows; use a new timestamped target or --append")

    imported = skipped = errors = 0
    started = time.time()
    first_write = True if table is None else False
    error_samples: List[str] = []

    for batch in chunks(rows, max(1, args.batch_size)):
        texts = [str(r.get("text") or r.get("content") or "") for r in batch]
        try:
            vectors = embed_batch(texts, api_key=cfg["api_key"], base_url=cfg.get("base_url", DEFAULT_BASE_URL), model=cfg.get("model", DEFAULT_MODEL), task="retrieval.passage", timeout=args.timeout)
            out_rows = [convert_row(r, v, cfg.get("model", DEFAULT_MODEL)) for r, v in zip(batch, vectors)]
            if first_write:
                table = tgt_db.create_table(args.target_table, data=out_rows)
                first_write = False
            else:
                assert table is not None
                table.add(out_rows)
            imported += len(out_rows)
        except Exception as exc:
            errors += len(batch)
            if len(error_samples) < 5:
                error_samples.append(exc.__class__.__name__ + ": " + str(exc)[:120])
        done = imported + skipped + errors
        if done and (done % args.progress_every == 0 or done == len(rows)):
            eprint("progress", done, "/", len(rows), "imported", imported, "errors", errors)

    final_count = int(table.count_rows()) if table is not None else 0
    manifest = {
        "source_path": str(source),
        "source_table": args.source_table,
        "source_total_rows": total,
        "target_path": str(target),
        "target_table": args.target_table,
        "records_selected": len(rows),
        "records_imported": imported,
        "records_skipped": skipped,
        "records_errors": errors,
        "target_count": final_count,
        "embedding_provider": "jina",
        "embedding_model": cfg.get("model", DEFAULT_MODEL),
        "embedding_dimensions_expected": DEFAULT_DIM,
        "embedding_task": "retrieval.passage",
        "api_key_present": True,
        "api_key_source": cfg.get("source", "unknown"),
        "duration_seconds": round(time.time() - started, 3),
        "error_samples": error_samples,
    }
    if args.manifest:
        Path(args.manifest).parent.mkdir(parents=True, exist_ok=True)
        Path(args.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, sort_keys=True))
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
