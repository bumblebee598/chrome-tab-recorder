"""Pure builder for the transcript Doc's batchUpdate requests.

All indexes are precomputed against an empty body (starting at 1), in UTF-16
code units — the Docs API counts UTF-16, Python counts code points, and the
difference (emoji in a tab title, say) corrupts every subsequent range.
Each paragraph gets an explicit namedStyleType because inserted text inherits
the style at the insertion point (a heading would bleed into the body).
"""

from dataclasses import dataclass
from typing import Any

BATCH_SIZE = 100


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def format_clock(ms: int) -> str:
    total = ms // 1000
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


@dataclass
class Turn:
    label: str
    start_ms: int
    text: str


def speaker_label(utterance: dict[str, Any], channels: int) -> str:
    channel = utterance.get("channel")
    speaker = utterance.get("speaker")
    if channels == 2 and channel is not None:
        # We recorded L=tab as channel 1, R=mic as channel 2
        base = "Tab audio" if str(channel) == "1" else "You (mic)"
        if speaker is not None and str(speaker) != str(channel):
            return f"{base} – Speaker {speaker}"
        return base
    return f"Speaker {speaker}" if speaker is not None else "Speaker"


def turns_from_transcript(transcript: dict[str, Any], channels: int) -> list[Turn]:
    utterances = transcript.get("utterances") or []
    turns = [
        Turn(
            label=speaker_label(u, channels),
            start_ms=int(u.get("start", 0)),
            text=(u.get("text") or "").strip(),
        )
        for u in utterances
        if (u.get("text") or "").strip()
    ]
    if turns:
        return turns
    text = (transcript.get("text") or "").strip()
    return [Turn(label="Transcript", start_ms=0, text=text)] if text else []


def build_doc_batches(
    title: str,
    recorded_at: str,
    duration_ms: int,
    recording_url: str,
    turns: list[Turn],
) -> list[list[dict[str, Any]]]:
    requests: list[dict[str, Any]] = []
    index = 1

    def paragraph(
        text: str,
        style: str = "NORMAL_TEXT",
        bold_until: int = 0,
        link: tuple[int, int, str] | None = None,
    ) -> None:
        nonlocal index
        content = text + "\n"
        length = utf16_len(content)
        requests.append({"insertText": {"location": {"index": index}, "text": content}})
        requests.append(
            {
                "updateParagraphStyle": {
                    "range": {"startIndex": index, "endIndex": index + length},
                    "paragraphStyle": {"namedStyleType": style},
                    "fields": "namedStyleType",
                }
            }
        )
        if bold_until > 0:
            requests.append(
                {
                    "updateTextStyle": {
                        "range": {"startIndex": index, "endIndex": index + bold_until},
                        "textStyle": {"bold": True},
                        "fields": "bold",
                    }
                }
            )
        if link:
            start, end, url = link
            requests.append(
                {
                    "updateTextStyle": {
                        "range": {"startIndex": index + start, "endIndex": index + end},
                        "textStyle": {"link": {"url": url}},
                        "fields": "link",
                    }
                }
            )
        index += length

    paragraph(title, style="HEADING_1")
    paragraph(f"Recorded: {recorded_at}")
    paragraph(f"Duration: {format_clock(duration_ms)}")
    link_label = "Open the recording in Drive"
    paragraph(link_label, link=(0, utf16_len(link_label), recording_url))
    paragraph("Transcript", style="HEADING_2")

    for turn in turns:
        prefix = f"{turn.label} — {format_clock(turn.start_ms)}"
        paragraph(f"{prefix}  {turn.text}", bold_until=utf16_len(prefix))

    return [requests[i : i + BATCH_SIZE] for i in range(0, len(requests), BATCH_SIZE)]


def clear_body_request(end_index: int) -> dict[str, Any] | None:
    """Everything except the mandatory final newline; None when already empty."""
    if end_index <= 2:
        return None
    return {"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index - 1}}}
