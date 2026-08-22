import json
import re


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


def normalize_capture_content(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text

    session_info = parsed.get("info") if isinstance(parsed, dict) else {}
    messages = parsed.get("messages") if isinstance(parsed, dict) else []

    compact_messages = []
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            info = message.get("info") if isinstance(message.get("info"), dict) else {}
            role = str(info.get("role") or "")
            parts = (
                message.get("parts") if isinstance(message.get("parts"), list) else []
            )

            text_parts = []
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
                cleaned = trim_embedded_content(value.strip())
                if cleaned:
                    text_parts.append(cleaned)

            if not text_parts:
                continue

            compact_messages.append(
                {
                    "role": role,
                    "text": "\n\n".join(text_parts),
                }
            )

    compact = {
        "session": {
            "id": session_info.get("id"),
            "title": session_info.get("title"),
            "directory": session_info.get("directory"),
        },
        "messages": compact_messages,
    }
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
