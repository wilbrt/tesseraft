#!/usr/bin/env python3
import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator


SCHEMA = json.loads(Path("schemas/fragment-package.schema.json").read_text())
VALID_PACKAGE = {
    "api-version": "tesseraft.fragment/v1",
    "kind": "fragment",
    "metadata": {"name": "schema-contract-fixture"},
    "interface": {
        "inputs": {"repo-root": {"type": "string", "required": True}},
        "outputs": {"status": {"schema": "schemas/status.schema.json", "required": True}},
        "outcomes": ["pass"],
    },
    "fragment": {
        "initial": "done",
        "exit": [{"on": "pass", "produces": {"status": "status/status.json"}}],
        "states": {
            "done": {"type": "terminal", "status": "success", "outcome": "pass"}
        },
    },
}


def errors_for(package):
    return list(Draft202012Validator(SCHEMA).iter_errors(package))


def assert_valid(package):
    errors = errors_for(package)
    assert errors == [], [e.message for e in errors]


def assert_invalid(package, expected_path):
    errors = errors_for(package)
    paths = {tuple(e.absolute_path) for e in errors}
    assert tuple(expected_path) in paths, [list(p) for p in paths]


def test_fragment_schema_requires_fi1_outcome_exit_terminal_and_nesting_contract():
    assert_valid(VALID_PACKAGE)

    missing_outcomes = deepcopy(VALID_PACKAGE)
    del missing_outcomes["interface"]["outcomes"]
    assert_invalid(missing_outcomes, ["interface"])

    missing_exit = deepcopy(VALID_PACKAGE)
    del missing_exit["fragment"]["exit"]
    assert_invalid(missing_exit, ["fragment"])

    empty_exit = deepcopy(VALID_PACKAGE)
    empty_exit["fragment"]["exit"] = []
    assert_invalid(empty_exit, ["fragment", "exit"])

    terminal_missing_outcome = deepcopy(VALID_PACKAGE)
    del terminal_missing_outcome["fragment"]["states"]["done"]["outcome"]
    assert_invalid(terminal_missing_outcome, ["fragment", "states", "done"])

    terminal_multi_outcome = deepcopy(VALID_PACKAGE)
    terminal_multi_outcome["fragment"]["states"]["done"]["outcome"] = ["pass", "fail"]
    assert_invalid(terminal_multi_outcome, ["fragment", "states", "done", "outcome"])

    nested_fragment = deepcopy(VALID_PACKAGE)
    nested_fragment["fragment"]["states"]["done"] = {"type": "fragment", "fragment": "child"}
    assert_invalid(nested_fragment, ["fragment", "states", "done"])


def test_fragment_schema_accepts_v1_state_transition_and_requirement_shapes():
    package = deepcopy(VALID_PACKAGE)
    package["requirements"] = {
        "executors": ["pi-cli"],
        "handlers": ["noop/succeed"],
        "tools": ["read", "bash"],
    }
    package["fragment"]["initial"] = "lint"
    package["fragment"]["states"] = {
        "lint": {
            "type": "deterministic",
            "handler": "noop/succeed",
            "tools": ["read"],
            "transitions": [{"when": {"status": "pass"}, "effects": ["inc-round"], "next": "done"}],
        },
        "done": {"type": "terminal", "status": "success", "outcome": "pass"},
    }
    assert_valid(package)

    missing_type = deepcopy(package)
    del missing_type["fragment"]["states"]["lint"]["type"]
    assert_invalid(missing_type, ["fragment", "states", "lint"])

    unknown_type = deepcopy(package)
    unknown_type["fragment"]["states"]["lint"]["type"] = "not-a-v1-state"
    assert_invalid(unknown_type, ["fragment", "states", "lint", "type"])


if __name__ == "__main__":
    test_fragment_schema_requires_fi1_outcome_exit_terminal_and_nesting_contract()
    test_fragment_schema_accepts_v1_state_transition_and_requirement_shapes()
