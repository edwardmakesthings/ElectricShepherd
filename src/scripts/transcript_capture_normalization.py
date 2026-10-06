import json
import re
from datetime import datetime, timezone
import math

RUNTIME_POLICY_MARKERS = (
    "[Memory Checkpoint]",
    "[Auto-Retry Guard]",
    "[Spiral Guard]",
    "[Loop Guard]",
    "[Mem-core Reinjection]",
)


# ECMAScript whitespace, shared behavior with TypeScript trimStart and /\s/u.
POLICY_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def runtime_policy_kind(role: str, text: str):
    if role != "user":
        return None
    value = text.lstrip(POLICY_WHITESPACE)
    for marker in RUNTIME_POLICY_MARKERS:
        if value.startswith(marker) and (
            len(value) == len(marker) or value[len(marker)] in POLICY_WHITESPACE
        ):
            return marker
    return None


TRIMMED_CONTENT_MARKER = (
    "<content>\n[trimmed by source-capture normalization]\n</content>"
)


def trim_embedded_content(text_value: str) -> str:
    if "<content>" in text_value and "</content>" in text_value:
        return re.sub(
            r"<content>.*?</content>",
            TRIMMED_CONTENT_MARKER,
            text_value,
            flags=re.DOTALL,
        )
    return text_value


def _message_role_and_text_parts(message: dict) -> tuple:
    """Return (role, text parts) for a v1 or v2 OpenCode export message.

    v1 nests the role under ``info.role`` and text under ``parts``; v2 messages
    are flat: ``type`` is the role, users carry ``text``, and assistants carry a
    ``content`` list. Other v2 types (idle, synthetic, ...) are not transcript.
    """
    if isinstance(message.get("info"), dict):
        role = str(message["info"].get("role") or "")
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        return role, parts

    role = str(message.get("type") or "")
    if role == "user" and isinstance(message.get("text"), str):
        return role, [{"type": "text", "text": message["text"]}]
    if role == "assistant" and isinstance(message.get("content"), list):
        return role, message["content"]
    return role, []


def _exported_time(info: dict) -> dict:
    """OpenCode numeric clocks are Unix milliseconds; retain exported field meanings."""
    if not isinstance(info, dict):
        return {}
    raw = info.get("time")
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key in (
        "created",
        "updated",
        "completed",
        "streamed",
        "idle",
        "viewed",
        "archived",
    ):
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if value < 0 or value > 253402300799999 or not math.isfinite(value):
            continue
        try:
            result[key] = (
                datetime.fromtimestamp(value / 1000, timezone.utc)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
        except (ValueError, OverflowError, OSError):
            continue
    return result


def normalize_capture_content(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text

    session_info = parsed.get("info") if isinstance(parsed, dict) else {}
    if not isinstance(session_info, dict):
        session_info = {}
    messages = parsed.get("messages") if isinstance(parsed, dict) else []

    compact_messages = []
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            role, parts = _message_role_and_text_parts(message)

            text_parts = []
            original_text_parts = []
            for part in parts:
                if not isinstance(part, dict):
                    continue
                if part.get("type") != "text":
                    continue
                if bool(part.get("synthetic")):
                    continue
                value = part.get("text")
                if not isinstance(value, str):
                    continue
                original_text_parts.append(value)
                cleaned = trim_embedded_content(value.strip(POLICY_WHITESPACE))
                if cleaned:
                    text_parts.append(cleaned)

            if not text_parts:
                continue

            if runtime_policy_kind(role, "\n\n".join(original_text_parts)):
                continue

            compact_message = {"role": role, "text": "\n\n".join(text_parts)}
            time = _exported_time(message.get("info") or message)
            if time:
                compact_message["time"] = time
            compact_messages.append(compact_message)

    session = {
        "id": session_info.get("id"),
        "title": session_info.get("title"),
        "directory": session_info.get("directory")
        or (session_info.get("location") or {}).get("directory"),
    }
    time = _exported_time(session_info)
    if time:
        session["time"] = time
    compact = {"session": session, "messages": compact_messages}
    return json.dumps(compact, ensure_ascii=False, separators=(",", ":"))


def render_readable_preview(normalized_json: str) -> str:
    try:
        payload = json.loads(normalized_json)
    except json.JSONDecodeError:
        return normalized_json

    out: list[str] = []
    session = payload.get("session") if isinstance(payload, dict) else None
    if isinstance(session, dict):
        out.append(f"session_id: {session.get('id', '')}")
        out.append(f"title: {session.get('title', '')}")
        out.append(f"directory: {session.get('directory', '')}")
        out.append("")

    messages = payload.get("messages") if isinstance(payload, dict) else None
    if not isinstance(messages, list):
        return "\n".join(out).strip() + "\n"

    for idx, message in enumerate(messages, start=1):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "")
        text = message.get("text")
        out.append(f"--- message {idx} role={role}")
        if isinstance(text, str) and text.strip():
            out.append(text)
        out.append("")

    return "\n".join(out).strip() + "\n"
