#!/usr/bin/env python3
"""MemPalace-backed coordinator for standalone ElectricShepherd consolidation runs."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _print(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def _candidate_mempalace_roots() -> list[Path]:
    script_path = Path(__file__).resolve()
    roots: list[Path] = []
    env_root = os.environ.get("ESHEPHERD_MEMPALACE_REPO", "").strip()
    if env_root:
        roots.append(Path(env_root).expanduser().resolve())
    roots.append((script_path.parents[2] / "mempalace").resolve())
    roots.append((Path.cwd().resolve().parent / "mempalace").resolve())
    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root)
        if key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return unique


def _import_mempalace_daemon():
    last_error: Exception | None = None
    try:
        from mempalace.daemon import QueueStore, _pid_alive

        return QueueStore, _pid_alive
    except Exception as exc:
        last_error = exc
        for root in _candidate_mempalace_roots():
            package_dir = root / "mempalace"
            if not package_dir.exists():
                continue
            sys.path.insert(0, str(root))
            try:
                from mempalace.daemon import QueueStore, _pid_alive

                return QueueStore, _pid_alive
            except Exception as inner_exc:
                last_error = inner_exc
                continue
    raise RuntimeError(f"mempalace import failed: {last_error}")


_QUEUE_API: tuple[Any, Any] | None = None


def _queue_api() -> tuple[Any, Any]:
    global _QUEUE_API
    if _QUEUE_API is not None:
        return _QUEUE_API
    _QUEUE_API = _import_mempalace_daemon()
    return _QUEUE_API


DEFAULT_DEDUPE_KEY = "electric-shepherd:consolidation:singleton"
DEFAULT_KIND = "electric_shepherd_consolidation_lock"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_queue_path(project_root: str) -> str:
    return str(Path(project_root) / ".electric-shepherd" / "consolidation-native-queue.sqlite3")


def _safe_json_loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _active_row(conn: sqlite3.Connection, dedupe_key: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT *
        FROM jobs
        WHERE dedupe_key = ? AND state IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (dedupe_key,),
    ).fetchone()


def _extract_owner(row: sqlite3.Row | None) -> tuple[int, int, str]:
    if row is None:
        return (0, 0, "")
    payload = _safe_json_loads(row["payload_json"])
    owner_pid = int(payload.get("owner_pid") or 0)
    started_at_ms = int(payload.get("startedAtMs") or 0)
    run_id = str(payload.get("run_id") or "")
    return (owner_pid, started_at_ms, run_id)


def _acquire(args: argparse.Namespace) -> int:
    QueueStore, _pid_alive = _queue_api()
    project_root = os.path.abspath(os.path.expanduser(args.project_root))
    queue_path = args.queue_path or _default_queue_path(project_root)
    dedupe_key = args.dedupe_key or DEFAULT_DEDUPE_KEY
    owner_pid = int(args.owner_pid)
    stale_ms = max(1, int(args.stale_ms))
    run_id = str(args.run_id)
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    store = QueueStore(Path(queue_path))

    with store._lock, store._connect() as conn:
        row = _active_row(conn, dedupe_key)
        if row is not None:
            holder_pid, holder_started_ms, holder_run_id = _extract_owner(row)
            holder_alive = holder_pid > 0 and _pid_alive(holder_pid)

            if holder_alive:
                _print(
                    {
                        "ok": True,
                        "acquired": False,
                        "reason": "held-by-live-owner",
                        "holder_pid": holder_pid,
                        "holder_run_id": holder_run_id,
                        "queue_path": queue_path,
                    }
                )
                return 0

            if holder_started_ms > 0 and now_ms - holder_started_ms < stale_ms:
                _print(
                    {
                        "ok": True,
                        "acquired": False,
                        "reason": "held-fresh-no-pid",
                        "holder_pid": holder_pid,
                        "holder_run_id": holder_run_id,
                        "queue_path": queue_path,
                    }
                )
                return 0

            conn.execute(
                "DELETE FROM jobs WHERE dedupe_key = ? AND state IN ('queued', 'running')",
                (dedupe_key,),
            )

        payload_json = json.dumps(
            {
                "owner_pid": owner_pid,
                "run_id": run_id,
                "startedAtMs": now_ms,
                "source": "electric-shepherd-native-coordinator",
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        job_id = uuid.uuid4().hex
        now_iso = _utc_now()

        try:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, kind, payload_json, state, priority, dedupe_key,
                    created_at, started_at, attempts
                ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
                """,
                (job_id, DEFAULT_KIND, payload_json, 1000, dedupe_key, now_iso, now_iso, 1),
            )
        except sqlite3.IntegrityError:
            holder = _active_row(conn, dedupe_key)
            holder_pid, _, holder_run_id = _extract_owner(holder)
            _print(
                {
                    "ok": True,
                    "acquired": False,
                    "reason": "raced-active-owner",
                    "holder_pid": holder_pid,
                    "holder_run_id": holder_run_id,
                    "queue_path": queue_path,
                }
            )
            return 0

    _print(
        {
            "ok": True,
            "acquired": True,
            "job_id": job_id,
            "owner_pid": owner_pid,
            "run_id": run_id,
            "queue_path": queue_path,
        }
    )
    return 0


def _release(args: argparse.Namespace) -> int:
    QueueStore, _ = _queue_api()
    project_root = os.path.abspath(os.path.expanduser(args.project_root))
    queue_path = args.queue_path or _default_queue_path(project_root)
    dedupe_key = args.dedupe_key or DEFAULT_DEDUPE_KEY
    owner_pid = int(args.owner_pid)
    run_id = str(args.run_id or "")

    store = QueueStore(Path(queue_path))

    released_ids: list[str] = []
    with store._lock, store._connect() as conn:
        rows = conn.execute(
            """
            SELECT id, payload_json
            FROM jobs
            WHERE dedupe_key = ? AND state IN ('queued', 'running')
            """,
            (dedupe_key,),
        ).fetchall()

        for row in rows:
            payload = _safe_json_loads(row["payload_json"])
            row_pid = int(payload.get("owner_pid") or 0)
            row_run_id = str(payload.get("run_id") or "")
            if row_pid != owner_pid:
                continue
            if run_id and row_run_id != run_id:
                continue
            released_ids.append(str(row["id"]))

        if released_ids:
            placeholders = ",".join("?" for _ in released_ids)
            conn.execute(f"DELETE FROM jobs WHERE id IN ({placeholders})", tuple(released_ids))

    _print(
        {
            "ok": True,
            "released": bool(released_ids),
            "released_count": len(released_ids),
            "queue_path": queue_path,
        }
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MemPalace-backed consolidation coordinator")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("acquire", "release"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--project-root", required=True)
        cmd.add_argument("--owner-pid", required=True, type=int)
        cmd.add_argument("--run-id", required=(name == "acquire"))
        cmd.add_argument("--stale-ms", type=int, default=300000)
        cmd.add_argument("--dedupe-key", default=DEFAULT_DEDUPE_KEY)
        cmd.add_argument("--queue-path", default="")

    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    try:
        if args.command == "acquire":
            return _acquire(args)
        if args.command == "release":
            return _release(args)
    except Exception as exc:
        _print({"ok": False, "error": str(exc), "command": args.command})
        return 2
    _print({"ok": False, "error": f"unknown command: {args.command}"})
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
