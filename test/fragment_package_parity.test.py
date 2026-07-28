#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path


VALID_EDN = Path("test/fixtures/valid/fragment-parity/fragment.edn")
VALID_JSON = Path("test/fixtures/valid/fragment-parity/fragment.json")
INVALID_EDN = Path("test/fixtures/invalid/fragment-parity/fragment.edn")
INVALID_JSON = Path("test/fixtures/invalid/fragment-parity/fragment.json")


def bb_eval(expr):
    return subprocess.run(
        ["bb", "-e", expr],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def lint_codes(path, strict=False):
    args = ["./bin/tesseraft", "fragment", "lint", str(path), "--format", "json"]
    if strict:
        args.append("--strict")
    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    payload = json.loads(proc.stdout)
    return proc.returncode, sorted(d["code"] for d in payload.get("diagnostics", []))


def portable_projection(path):
    expr = f'''
(require '[tesseraft.spec :as spec]
         '[cheshire.core :as json])
(println (json/generate-string
           (spec/portable-fragment-package-data
             (spec/read-fragment-package "{path}"))))
'''
    proc = bb_eval(expr)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_valid_edn_json_fragment_packages_have_identical_portable_projection_and_lint():
    assert portable_projection(VALID_EDN) == portable_projection(VALID_JSON)
    assert lint_codes(VALID_EDN, strict=True) == (0, [])
    assert lint_codes(VALID_JSON, strict=True) == (0, [])


def test_invalid_edn_json_fragment_packages_have_same_diagnostic_codes():
    edn_status, edn_codes = lint_codes(INVALID_EDN, strict=True)
    json_status, json_codes = lint_codes(INVALID_JSON, strict=True)
    assert edn_status != 0
    assert json_status != 0
    assert edn_codes == json_codes
    for expected in {
        "duplicate-exit",
        "fragment-exit-missing-output",
        "fragment-outcome-mismatch",
        "fragment-terminal-unknown-outcome",
        "fragment-unreachable-outcome",
        "nested-fragment",
        "unknown-effect",
        "unknown-next-state",
    }:
        assert expected in edn_codes


def test_portable_fragment_projection_is_json_compatible_and_namespace_preserving():
    projection = portable_projection(VALID_JSON)
    encoded = json.dumps(projection, sort_keys=True)
    assert "custom/review" in encoded
    assert projection["fragment"]["policies"]["allowed-agent-tools"] == ["custom/review"]
    assert isinstance(projection["interface"]["outcomes"], list)
    assert projection["interface"]["outcomes"] == ["fail", "pass"]
    assert "__file" not in projection
    assert "__dir" not in projection


if __name__ == "__main__":
    test_valid_edn_json_fragment_packages_have_identical_portable_projection_and_lint()
    test_invalid_edn_json_fragment_packages_have_same_diagnostic_codes()
    test_portable_fragment_projection_is_json_compatible_and_namespace_preserving()
