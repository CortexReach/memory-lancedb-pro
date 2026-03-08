#!/usr/bin/env python3
"""jsonl_distill.py

Incrementally extract new chat messages from OpenClaw session JSONL files and
write a compact batch file for a distiller agent to turn into LanceDB memories.

Design goals:
- Read only the newly-appended tail of each session file (byte-offset cursor).
- Avoid token waste: if there is no new content, produce no batch.
- Safety: never delete/modify session logs.
- Robustness: handle file rotation/truncation using inode+size checks.

This script does NOT call any LLM or write to LanceDB. It only prepares data
for the distiller agent.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_STATE_DIR = Path.home() / ".openclaw" / "state" / "jsonl-distill"
DEFAULT_AGENTS_DIR = Path.home() / ".openclaw" / "agents"

# Prevent self-ingestion loops: the distiller agent itself should never be a source.
EXCLUDED_AGENT_IDS = {
    "memory-distiller",
}

# Source allowlist (optional quality control).
# Default (env unset): allow all agents (except EXCLUDED_AGENT_IDS).
# If set: only distill from the listed agent IDs.
# Example:
#   OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS=main,code-agent
ENV_ALLOWED_AGENT_IDS = "OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS"


def _get_allowed_agent_ids() -> Optional[set[str]]:
    raw = os.environ.get(ENV_ALLOWED_AGENT_IDS, "").strip()
    if not raw or raw in ("*", "all"):
        return None
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return set(parts) if parts else None



NOISE_PREFIXES = (
    "✅ New session started",
    "NO_REPLY",
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", errors="ignore")).hexdigest()


def _read_jsonl_lines(path: Path, start_offset: int, max_bytes: int) -> Tuple[List[str], int]:
    """Read up to max_bytes from path starting at start_offset. Returns (lines, end_offset)."""
    lines: List[str] = []
    with path.open("rb") as f:
        f.seek(start_offset)
        data = f.read(max_bytes)
        end_offset = f.tell()

    if not data:
        return [], end_offset

    # Ensure we end on a newline boundary to avoid partial JSON lines.
    if not data.endswith(b"\n"):
        last_nl = data.rfind(b"\n")
        if last_nl == -1:
            # No complete line in this chunk.
            return [], start_offset
        data = data[: last_nl + 1]
        end_offset = start_offset + len(data)

    text = data.decode("utf-8", errors="replace")
    for line in text.splitlines():
        line = line.strip()
        if line:
            lines.append(line)
    return lines, end_offset


def _extract_text_blocks(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str) and t:
                    parts.append(t)
        return "\n".join(parts)
    return ""


def _clean_text(s: str) -> str:
    s = s.strip()
    if not s:
        return ""

    # Drop injected memory blocks entirely.
    if "<relevant-memories>" in s:
        s = re.sub(r"<relevant-memories>[\s\S]*?</relevant-memories>", "", s)

    # Strip OpenClaw transcript headers that add noise but not meaning.
    # Keep the actual user content that follows.
    s = re.sub(r"^Conversation info \(untrusted metadata\):\s*\n+", "", s, flags=re.IGNORECASE)
    s = re.sub(r"^Replied message \(untrusted, for context\):\s*\n+", "", s, flags=re.IGNORECASE)

    # Drop embedded JSON blocks (often metadata) to reduce token waste.
    s = re.sub(r"```json[\s\S]*?```", "", s)

    # Collapse whitespace.
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _is_noise(s: str) -> bool:
    if not s:
        return True
    if s.lstrip().startswith("/"):
        return True
    for p in NOISE_PREFIXES:
        if s.startswith(p):
            return True

    lower = s.lower()

    # Drop transcript/system boilerplate that should never become memories.
    if "[queued messages while agent was busy]" in lower:
        return True
    if "you are running a boot check" in lower or "boot.md — gateway startup health check" in lower:
        return True
    if "read heartbeat.md" in lower:
        return True
    if "[claude_code_done]" in lower or "claude_code_done" in lower:
        return True

    # Skip overly long blocks (logs / dumps). The distiller can still capture the essence later.
    if len(s) > 2000:
        return True

    # Skip pure code fences (usually tool output).
    if s.strip().startswith("```") and s.strip().endswith("```"):
        return True

    return False


@dataclass
class CursorEntry:
    inode: int
    committed: int
    pending: Optional[int] = None
    pending_batch: Optional[str] = None
    last_size: Optional[int] = None


def _load_cursor(cursor_path: Path) -> Dict[str, Any]:
    if not cursor_path.exists():
        return {"version": 1, "files": {}, "createdAtMs": _now_ms(), "updatedAtMs": _now_ms()}
    return json.loads(cursor_path.read_text("utf-8"))


def _save_cursor(cursor_path: Path, cursor: Dict[str, Any]) -> None:
    cursor["updatedAtMs"] = _now_ms()
    cursor_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cursor_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cursor, ensure_ascii=False, indent=2) + "\n", "utf-8")
    tmp.replace(cursor_path)


def _list_session_files(agents_dir: Path) -> List[Tuple[str, Path]]:
    results: List[Tuple[str, Path]] = []
    if not agents_dir.exists():
        return results

    allowed_agent_ids = _get_allowed_agent_ids()

    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir():
            continue
        agent_id = agent_dir.name
        if agent_id in EXCLUDED_AGENT_IDS:
            continue
        if allowed_agent_ids is not None and agent_id not in allowed_agent_ids:
            continue
        sessions_dir = agent_dir / "sessions"
        if not sessions_dir.exists():
            continue

        for f in sorted(sessions_dir.iterdir()):
            name = f.name
            if not f.is_file():
                continue
            if not name.endswith(".jsonl"):
                continue
            if ".reset." in name:
                # Reset snapshots are historical; we start from now and focus on live session tails.
                continue
            if name.endswith(".lock") or ".deleted." in name:
                continue
            results.append((agent_id, f))

    return results


def init_from_now(state_dir: Path, agents_dir: Path) -> Dict[str, Any]:
    cursor_path = state_dir / "cursor.json"
    cursor = _load_cursor(cursor_path)
    files = cursor.setdefault("files", {})

    for agent_id, f in _list_session_files(agents_dir):
        st = f.stat()
        key = str(f)
        files[key] = {
            "agentId": agent_id,
            "inode": int(st.st_ino),
            "committed": int(st.st_size),
            "pending": None,
            "pendingBatch": None,
            "lastSize": int(st.st_size),
            "updatedAtMs": _now_ms(),
        }

    _save_cursor(cursor_path, cursor)
    return {
        "ok": True,
        "action": "init",
        "cursorPath": str(cursor_path),
        "trackedFiles": len(files),
    }


def run_extract(state_dir: Path, agents_dir: Path, max_bytes_per_file: int, max_messages_per_agent: int) -> Dict[str, Any]:
    cursor_path = state_dir / "cursor.json"
    cursor = _load_cursor(cursor_path)
    files: Dict[str, Any] = cursor.setdefault("files", {})

    # If there is a pending batch, return it and do not read new data.
    pending_batches = sorted({v.get("pendingBatch") for v in files.values() if v.get("pendingBatch")})
    pending_batches = [b for b in pending_batches if b]
    if pending_batches:
        return {
            "ok": True,
            "action": "pending",
            "batchFiles": pending_batches,
            "cursorPath": str(cursor_path),
        }

    # Collect new messages.
    per_agent_msgs: Dict[str, List[Dict[str, Any]]] = {}
    touched_files: List[Dict[str, Any]] = []

    for agent_id, f in _list_session_files(agents_dir):
        key = str(f)
        st = f.stat()
        inode = int(st.st_ino)
        size = int(st.st_size)

        entry = files.get(key)
        committed = 0
        if entry and entry.get("inode") == inode:
            committed = int(entry.get("committed") or 0)
            # Handle truncation.
            if size < committed:
                committed = 0
        else:
            # New file not tracked yet: start from EOF (A-mode behavior).
            committed = size

        if size <= committed:
            # Nothing new.
            files[key] = {
                "agentId": agent_id,
                "inode": inode,
                "committed": committed,
                "pending": None,
                "pendingBatch": None,
                "lastSize": size,
                "updatedAtMs": _now_ms(),
            }
            continue

        lines, end_offset = _read_jsonl_lines(f, committed, max_bytes_per_file)
        if not lines:
            # Might have hit partial line boundary; do not advance.
            continue

        extracted: List[Dict[str, Any]] = []
        for line in lines:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "message":
                continue
            msg = obj.get("message")
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue

            text = _extract_text_blocks(msg.get("content"))
            text = _clean_text(text)
            if _is_noise(text):
                continue

            extracted.append({
                "ts": obj.get("timestamp") or msg.get("timestamp"),
                "role": role,
                "text": text,
            })

        if not extracted:
            # Advance committed to end_offset anyway to avoid re-reading pure noise.
            files[key] = {
                "agentId": agent_id,
                "inode": inode,
                "committed": end_offset,
                "pending": None,
                "pendingBatch": None,
                "lastSize": size,
                "updatedAtMs": _now_ms(),
            }
            continue

        per_agent_msgs.setdefault(agent_id, []).extend(extracted)
        touched_files.append({
            "path": key,
            "agentId": agent_id,
            "inode": inode,
            "committed": committed,
            "pending": end_offset,
            "size": size,
        })

    # Cap messages per agent to keep token usage stable.
    for agent_id, msgs in per_agent_msgs.items():
        if len(msgs) > max_messages_per_agent:
            per_agent_msgs[agent_id] = msgs[-max_messages_per_agent:]

    if not per_agent_msgs:
        _save_cursor(cursor_path, cursor)
        return {
            "ok": True,
            "action": "noop",
            "cursorPath": str(cursor_path),
        }

    batches_dir = state_dir / "batches"
    batches_dir.mkdir(parents=True, exist_ok=True)
    batch_id = time.strftime("%Y%m%d-%H%M%S")
    batch_path = batches_dir / f"batch-{batch_id}.json"

    batch_obj = {
        "version": 1,
        "createdAtMs": _now_ms(),
        "agents": [
            {
                "agentId": agent_id,
                "messages": per_agent_msgs.get(agent_id, []),
            }
            for agent_id in sorted(per_agent_msgs.keys())
        ],
        "touchedFiles": touched_files,
    }

    batch_path.write_text(json.dumps(batch_obj, ensure_ascii=False, indent=2) + "\n", "utf-8")

    # Write pending offsets.
    for tf in touched_files:
        key = tf["path"]
        files[key] = {
            "agentId": tf["agentId"],
            "inode": tf["inode"],
            "committed": tf["committed"],
            "pending": tf["pending"],
            "pendingBatch": str(batch_path),
            "lastSize": tf["size"],
            "updatedAtMs": _now_ms(),
        }

    _save_cursor(cursor_path, cursor)

    return {
        "ok": True,
        "action": "created",
        "batchFile": str(batch_path),
        "agents": len(per_agent_msgs),
        "cursorPath": str(cursor_path),
    }


def commit_batch(state_dir: Path, batch_file: Path) -> Dict[str, Any]:
    cursor_path = state_dir / "cursor.json"
    cursor = _load_cursor(cursor_path)
    files: Dict[str, Any] = cursor.setdefault("files", {})

    committed_files = 0
    for key, v in list(files.items()):
        if v.get("pendingBatch") != str(batch_file):
            continue
        pending = v.get("pending")
        if pending is None:
            continue
        v["committed"] = int(pending)
        v["pending"] = None
        v["pendingBatch"] = None
        v["updatedAtMs"] = _now_ms()
        files[key] = v
        committed_files += 1

    _save_cursor(cursor_path, cursor)
    try:
        batch_file.unlink()
    except Exception:
        pass

    return {
        "ok": True,
        "action": "committed",
        "cursorPath": str(cursor_path),
        "committedFiles": committed_files,
        "batchFile": str(batch_file),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR))
    ap.add_argument("--agents-dir", default=str(DEFAULT_AGENTS_DIR))

    sub = ap.add_subparsers(dest="cmd", required=True)

    s_init = sub.add_parser("init", help="Initialize cursor to EOF for all current session files")

    s_run = sub.add_parser("run", help="Extract incremental message tail and create a batch file")
    s_run.add_argument("--max-bytes-per-file", type=int, default=256_000)
    s_run.add_argument("--max-messages-per-agent", type=int, default=30)

    s_commit = sub.add_parser("commit", help="Commit a processed batch (advance committed offsets)")
    s_commit.add_argument("--batch-file", required=True)

    args = ap.parse_args()

    state_dir = Path(args.state_dir).expanduser().resolve()
    agents_dir = Path(args.agents_dir).expanduser().resolve()

    if args.cmd == "init":
        out = init_from_now(state_dir, agents_dir)
        print(json.dumps(out, ensure_ascii=False))
        return 0

    if args.cmd == "run":
        out = run_extract(
            state_dir,
            agents_dir,
            max_bytes_per_file=int(args.max_bytes_per_file),
            max_messages_per_agent=int(args.max_messages_per_agent),
        )
        print(json.dumps(out, ensure_ascii=False))
        return 0

    if args.cmd == "commit":
        out = commit_batch(state_dir, Path(args.batch_file).expanduser().resolve())
        print(json.dumps(out, ensure_ascii=False))
        return 0

    raise RuntimeError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
