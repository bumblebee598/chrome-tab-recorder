"""Table-driven tests from shared/fixtures/transitions.json.

The extension runs the identical fixtures through the TypeScript implementation
(extension/src/lib/state/transition.test.ts). Harness contract is documented in
the fixture file's $comment.
"""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from app.domain.model import Event, Job
from app.domain.transitions import transition

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads((ROOT / "shared" / "fixtures" / "transitions.json").read_text())
SCHEMA = json.loads((ROOT / "shared" / "schema" / "job.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA)
CASES = FIXTURES["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_transition(case: dict) -> None:
    before = {**FIXTURES["defaults"], **case["before"]}
    expected = {**before, **case["after"]}

    VALIDATOR.validate(before)
    VALIDATOR.validate(expected)

    job = Job.model_validate(before)
    event = Event.model_validate(case["event"])
    result = transition(job, event)

    assert result.model_dump(by_alias=True, mode="json") == expected


def test_defaults_match_schema() -> None:
    VALIDATOR.validate(FIXTURES["defaults"])
