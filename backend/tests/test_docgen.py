from app.worker.docgen import (
    Turn,
    build_doc_batches,
    clear_body_request,
    format_clock,
    speaker_label,
    turns_from_transcript,
    utf16_len,
)


def test_utf16_len_counts_surrogate_pairs():
    assert utf16_len("abc") == 3
    assert utf16_len("🎙") == 2  # emoji = surrogate pair = 2 UTF-16 units


def test_format_clock():
    assert format_clock(0) == "00:00"
    assert format_clock(75_000) == "01:15"
    assert format_clock(2 * 3600 * 1000 + 61_000) == "2:01:01"


def test_speaker_labels_for_stereo():
    assert speaker_label({"channel": "1", "speaker": "1"}, 2) == "Tab audio"
    assert speaker_label({"channel": "2", "speaker": "2"}, 2) == "You (mic)"
    assert speaker_label({"channel": "1", "speaker": "A"}, 2) == "Tab audio – Speaker A"
    assert speaker_label({"speaker": "B"}, 1) == "Speaker B"


def test_turns_fall_back_to_plain_text():
    turns = turns_from_transcript({"text": "just text", "utterances": []}, 1)
    assert len(turns) == 1
    assert turns[0].text == "just text"


def test_batches_have_consistent_utf16_indexes():
    title = "Demo 🎙 recording"  # emoji makes python-len wrong, utf16-len right
    turns = [Turn(label="Tab audio", start_ms=0, text="Hello."), Turn("You (mic)", 65_000, "Hi!")]
    batches = build_doc_batches(title, "2026-10-08 (UTC)", 120_000, "https://drive.test/x", turns)

    requests = [request for batch in batches for request in batch]
    index = 1
    for request in requests:
        if "insertText" in request:
            assert request["insertText"]["location"]["index"] == index
            index += utf16_len(request["insertText"]["text"])
    # final running index == end of all inserted text
    total = sum(utf16_len(r["insertText"]["text"]) for r in requests if "insertText" in r)
    assert index == 1 + total

    # every paragraph carries an explicit named style
    inserts = [r for r in requests if "insertText" in r]
    styles = [r for r in requests if "updateParagraphStyle" in r]
    assert len(inserts) == len(styles)

    # recording link covers exactly the link label of that paragraph
    link = next(r for r in requests if "updateTextStyle" in r and "link" in r["updateTextStyle"]["textStyle"])
    link_range = link["updateTextStyle"]["range"]
    assert link_range["endIndex"] - link_range["startIndex"] == utf16_len(
        "Open the recording in Drive"
    )

    # speaker prefixes are bolded with mm:ss stamps
    bolds = [r for r in requests if "updateTextStyle" in r and r["updateTextStyle"]["textStyle"].get("bold")]
    assert len(bolds) == 2
    assert all(len(batch) <= 100 for batch in batches)


def test_clear_body_request():
    assert clear_body_request(1) is None
    assert clear_body_request(2) is None
    assert clear_body_request(50) == {
        "deleteContentRange": {"range": {"startIndex": 1, "endIndex": 49}}
    }
