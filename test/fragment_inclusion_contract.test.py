#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path.cwd()

FRAGMENT = '''{:api-version "tesseraft.fragment/v1"
 :kind :fragment
 :metadata {:name "contract-fragment" :version "1.2.3"}
 :interface {:inputs {:repo-root {:type :string :required true}
                      :count {:type :integer :required false}}
             :parameters {:mode {:type :string :default "safe"}
                          :retries {:type :integer :required true}
                          :ratio {:type :number :default 1.5}
                          :enabled {:type :boolean :default true}}
             :outputs {:status {:required true}}
             :outcomes #{:pass :fail}}
 :fragment {:initial :start
            :entry {:inputs [:repo-root :count]
                    :parameters [:mode :retries :ratio :enabled]}
            :exit [{:on :pass :produces {:status "status.json"}}
                   {:on :fail :produces {:status "status.json"}}]
            :states {:start {:type :router
                             :transitions [{:next :done}
                                           {:next :failed}]}
                     :done {:type :terminal :status :success :outcome :pass}
                     :failed {:type :terminal :status :failure :outcome :fail}}}}
'''


def write_fragment_package(tmp: Path, scope="project", package_text=FRAGMENT, name="contract-fragment"):
    roots = {
        "project": tmp / ".tesseraft/fragments",
        "global": tmp / "global-home/fragments",
        "examples": tmp / "examples/fragments",
    }
    package_root = roots[scope] / name
    package_root.mkdir(parents=True, exist_ok=True)
    (package_root / "fragment.edn").write_text(package_text)
    return package_root / "fragment.edn"


def write_project(tmp: Path, package_text=FRAGMENT, workflow_node=None, global_package=False, write_package=True):
    if write_package:
        write_fragment_package(tmp, "global" if global_package else "project", package_text)
    node = workflow_node or ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :version "1.2.3"
   :scope "project"
   :prefix "nested/path"
   :inputs {:repo-root "." :count 2}
   :parameters {:retries 3}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
    workflow = f'''{{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {{:name "contract-workflow"}}
 :initial :run
 :states
 {{{node}
  :done {{:type :terminal :status :success}}
  :fail {{:type :terminal :status :failure}}}}}}
'''
    wf = tmp / "workflow.edn"
    wf.write_text(workflow)
    return wf


def tesseraft(args, home: Path):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    return subprocess.run(
        ["./bin/tesseraft", *args],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def lint(wf: Path, home: Path):
    proc = tesseraft(["lint", str(wf), "--format", "json"], home)
    assert proc.stdout, proc.stderr
    return proc.returncode, json.loads(proc.stdout)


def codes(payload):
    return {d["code"] for d in payload.get("diagnostics", [])}


def with_tmp(fn):
    tmp = Path(tempfile.mkdtemp(prefix="tesseraft-fi3-"))
    try:
        return fn(tmp)
    finally:
        shutil.rmtree(tmp)


def test_effective_inclusion_contract_is_inspectable_and_defaults_are_merged():
    def run(tmp):
        home = tmp / "global-home"
        wf = write_project(tmp)
        status, payload = lint(wf, home)
        assert status == 0, payload
        inclusion = payload["fragment-inclusions"]["run"]
        assert inclusion["scope"] == "project", inclusion
        assert inclusion["version"] == "1.2.3", inclusion
        assert inclusion["prefix"] == "nested/path", inclusion
        assert inclusion["package-path"].endswith(".tesseraft/fragments/contract-fragment/fragment.edn"), inclusion
        assert inclusion["inputs"] == {"repo-root": ".", "count": 2}, inclusion
        assert inclusion["parameters"] == {"mode": "safe", "retries": 3, "ratio": 1.5, "enabled": True}, inclusion
    with_tmp(run)


def test_explicit_project_scope_does_not_fall_back_to_global():
    def run(tmp):
        home = tmp / "global-home"
        node = ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :scope :project
   :inputs {:repo-root "."}
   :parameters {:retries 1}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
        wf = write_project(tmp, workflow_node=node, global_package=True)
        status, payload = lint(wf, home)
        assert status != 0
        assert "fragment-unknown-package" in codes(payload), payload
    with_tmp(run)


def test_missing_and_nil_fragment_identity_are_invalid_names_not_unknown_packages():
    def run(tmp):
        home = tmp / "global-home"
        for fragment_form in ["", ":fragment nil"]:
            node = f''':run
  {{:type :fragment
   {fragment_form}
   :inputs {{:repo-root "."}}
   :parameters {{:retries 1}}
   :transitions [{{:when {{:fragment/outcome "pass"}} :next :done}}
                 {{:when {{:fragment/outcome "fail"}} :next :fail}}]}}'''
            wf = write_project(tmp, workflow_node=node)
            status, payload = lint(wf, home)
            got = codes(payload)
            assert status != 0, payload
            assert "fragment-invalid-name" in got, payload
            assert "fragment-unknown-package" not in got, payload
    with_tmp(run)


def test_default_resolution_prefers_project_then_global_then_examples():
    def run(tmp):
        home = tmp / "global-home"
        write_fragment_package(tmp, "examples")
        write_fragment_package(tmp, "global")
        write_fragment_package(tmp, "project")
        wf = write_project(tmp, write_package=False, workflow_node=''':run
  {:type :fragment
   :fragment "contract-fragment"
   :inputs {:repo-root "."}
   :parameters {:retries 1}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}''')
        status, payload = lint(wf, home)
        assert status == 0, payload
        inclusion = payload["fragment-inclusions"]["run"]
        assert inclusion["scope"] == "project", inclusion
        assert inclusion["package-path"].endswith(".tesseraft/fragments/contract-fragment/fragment.edn"), inclusion

        shutil.rmtree(tmp / ".tesseraft")
        status, payload = lint(wf, home)
        assert status == 0, payload
        inclusion = payload["fragment-inclusions"]["run"]
        assert inclusion["scope"] == "global", inclusion
        assert inclusion["package-path"].endswith("global-home/fragments/contract-fragment/fragment.edn"), inclusion

        shutil.rmtree(tmp / "global-home/fragments")
        status, payload = lint(wf, home)
        assert status == 0, payload
        inclusion = payload["fragment-inclusions"]["run"]
        assert inclusion["scope"] == "examples", inclusion
        assert inclusion["package-path"].endswith("examples/fragments/contract-fragment/fragment.edn"), inclusion
    with_tmp(run)


def test_explicit_scope_values_and_aliases_select_canonical_scope():
    def run(tmp):
        home = tmp / "global-home"
        cases = [
            (':project', "project", ".tesseraft/fragments/contract-fragment/fragment.edn"),
            ('"project"', "project", ".tesseraft/fragments/contract-fragment/fragment.edn"),
            (':global', "global", "global-home/fragments/contract-fragment/fragment.edn"),
            ('"global"', "global", "global-home/fragments/contract-fragment/fragment.edn"),
            (':examples', "examples", "examples/fragments/contract-fragment/fragment.edn"),
            ('"examples"', "examples", "examples/fragments/contract-fragment/fragment.edn"),
            (':example', "examples", "examples/fragments/contract-fragment/fragment.edn"),
            ('"example"', "examples", "examples/fragments/contract-fragment/fragment.edn"),
            (':configured', "examples", "examples/fragments/contract-fragment/fragment.edn"),
            ('"configured"', "examples", "examples/fragments/contract-fragment/fragment.edn"),
        ]
        write_fragment_package(tmp, "project")
        write_fragment_package(tmp, "global")
        write_fragment_package(tmp, "examples")
        for scope_form, expected_scope, expected_suffix in cases:
            node = f''':run
  {{:type :fragment
   :fragment "contract-fragment"
   :scope {scope_form}
   :inputs {{:repo-root "."}}
   :parameters {{:retries 1}}
   :transitions [{{:when {{:fragment/outcome "pass"}} :next :done}}
                 {{:when {{:fragment/outcome "fail"}} :next :fail}}]}}'''
            wf = write_project(tmp, workflow_node=node, write_package=False)
            status, payload = lint(wf, home)
            assert status == 0, (scope_form, payload)
            inclusion = payload["fragment-inclusions"]["run"]
            assert inclusion["scope"] == expected_scope, (scope_form, inclusion)
            assert inclusion["package-path"].endswith(expected_suffix), (scope_form, inclusion)
    with_tmp(run)


def test_version_binding_type_name_and_prefix_diagnostics_are_distinct():
    def run(tmp):
        home = tmp / "global-home"
        node = ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :version "9.9.9"
   :prefix "../bad"
   :inputs {:repo-root nil :unknown true}
   :parameters {:retries "3" :extra 1}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
        wf = write_project(tmp, workflow_node=node)
        status, payload = lint(wf, home)
        got = codes(payload)
        assert status != 0
        for expected in {
            "fragment-version-mismatch",
            "fragment-invalid-prefix",
            "fragment-input-binding-missing",
            "fragment-unknown-input",
            "fragment-parameter-type-mismatch",
            "fragment-unknown-parameter",
        }:
            assert expected in got, payload
    with_tmp(run)


def test_wrong_scalar_literals_and_unsupported_declared_types_fail_without_coercion():
    def run(tmp):
        home = tmp / "global-home"
        pkg = FRAGMENT.replace(':ratio {:type :number :default 1.5}', ':ratio {:type :float :default 1.5}')
        node = ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :inputs {:repo-root 7 :count "2"}
   :parameters {:retries 1 :enabled "true"}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
        wf = write_project(tmp, package_text=pkg, workflow_node=node)
        status, payload = lint(wf, home)
        got = codes(payload)
        assert status != 0
        assert "fragment-input-type-mismatch" in got, payload
        assert "fragment-parameter-type-mismatch" in got, payload
        assert "fragment-unsupported-scalar-type" in got, payload
    with_tmp(run)


def test_missing_scalar_types_are_rejected_before_effective_inclusion_data():
    def run(tmp):
        home = tmp / "global-home"
        pkg = FRAGMENT.replace(':repo-root {:type :string :required true}', ':repo-root {:required true}')
        pkg = pkg.replace(':mode {:type :string :default "safe"}', ':mode {:type nil :default {:unsafe true}}')
        node = ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :inputs {:repo-root {:unsafe true} :count 2}
   :parameters {:retries 1}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
        wf = write_project(tmp, package_text=pkg, workflow_node=node)
        status, payload = lint(wf, home)
        got = codes(payload)
        assert status != 0, payload
        assert "fragment-missing-scalar-type" in got, payload
        assert "run" not in payload.get("fragment-inclusions", {}), payload
    with_tmp(run)


def test_invalid_binding_names_and_normalization_collisions_are_rejected_precisely():
    def run(tmp):
        home = tmp / "global-home"
        bad_pkg = FRAGMENT.replace(
            ':repo-root {:type :string :required true}',
            ':repo-root {:type :string :required true}\n                      7 {:type :string :required false}\n                      "repo-root" {:type :string :required false}',
        )
        node = ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :inputs {7 "bad" :repo-root "." "repo-root" "collision"}
   :parameters {:retries 1 [] "bad"}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
        wf = write_project(tmp, package_text=bad_pkg, workflow_node=node)
        status, payload = lint(wf, home)
        got = codes(payload)
        assert status != 0
        assert "fragment-invalid-binding-name" in got, payload
        assert "fragment-binding-name-collision" in got, payload
        assert "fragment-internal-lint-failed" not in got, payload
    with_tmp(run)


def test_prefix_validation_rejects_dot_segments_and_windows_drive_forms():
    def run(tmp):
        home = tmp / "global-home"
        unsafe = ["nested/./path", "nested/.", "C:relative", "C:/absolute", r"\\server\\share", r"nested\\..\\path"]
        for prefix in unsafe:
            node = f''':run
  {{:type :fragment
   :fragment "contract-fragment"
   :prefix {json.dumps(prefix)}
   :inputs {{:repo-root "."}}
   :parameters {{:retries 1}}
   :transitions [{{:when {{:fragment/outcome "pass"}} :next :done}}
                 {{:when {{:fragment/outcome "fail"}} :next :fail}}]}}'''
            wf = write_project(tmp, workflow_node=node)
            status, payload = lint(wf, home)
            assert status != 0, (prefix, payload)
            assert "fragment-invalid-prefix" in codes(payload), (prefix, payload)
    with_tmp(run)


def test_fragment_name_must_be_single_safe_package_name_and_stay_under_scope_root():
    def run(tmp):
        home = tmp / "global-home"
        escape_root = tmp / ".tesseraft/escape"
        escape_root.mkdir(parents=True)
        (escape_root / "fragment.edn").write_text(FRAGMENT)
        for fragment_name in ["../escape", "nested/name", r"nested\\name", ".", "C:escape"]:
            node = f''':run
  {{:type :fragment
   :fragment {json.dumps(fragment_name)}
   :scope :project
   :inputs {{:repo-root "."}}
   :parameters {{:retries 1}}
   :transitions [{{:when {{:fragment/outcome "pass"}} :next :done}}
                 {{:when {{:fragment/outcome "fail"}} :next :fail}}]}}'''
            wf = write_project(tmp, workflow_node=node)
            status, payload = lint(wf, home)
            assert status != 0, (fragment_name, payload)
            assert "fragment-invalid-name" in codes(payload), (fragment_name, payload)
            assert "fragment-unknown-package" not in codes(payload), (fragment_name, payload)
    with_tmp(run)


def test_resolved_package_metadata_name_must_match_requested_fragment():
    def run(tmp):
        home = tmp / "global-home"
        mismatch = FRAGMENT.replace(':metadata {:name "contract-fragment" :version "1.2.3"}',
                                    ':metadata {:name "other-fragment" :version "1.2.3"}')
        wf = write_project(tmp, package_text=mismatch)
        status, payload = lint(wf, home)
        assert status != 0, payload
        got = codes(payload)
        assert "fragment-name-mismatch" in got, payload
        assert "fragment-internal-lint-failed" not in got, payload
    with_tmp(run)


def test_malformed_binding_containers_and_contract_entries_are_rejected():
    def run(tmp):
        home = tmp / "global-home"
        bad_pkg = FRAGMENT.replace(':inputs {:repo-root {:type :string :required true}\n                      :count {:type :integer :required false}}',
                                   ':inputs {:repo-root "not-a-contract"\n                      :count {:type :integer :required false}}')
        bad_pkg = bad_pkg.replace(':parameters {:mode {:type :string :default "safe"}\n                          :retries {:type :integer :required true}\n                          :ratio {:type :number :default 1.5}\n                          :enabled {:type :boolean :default true}}',
                                  ':parameters []')
        node = ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :inputs []
   :parameters []
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
        wf = write_project(tmp, package_text=bad_pkg, workflow_node=node)
        status, payload = lint(wf, home)
        got = codes(payload)
        assert status != 0, payload
        assert "fragment-bindings-not-map" in got, payload
        assert "fragment-interface-bindings-not-map" in got, payload
        assert "fragment-binding-contract-not-map" in got, payload
        assert "fragment-internal-lint-failed" not in got, payload
    with_tmp(run)


def test_repeated_broken_package_inclusions_never_emit_effective_data():
    def run(tmp):
        home = tmp / "global-home"
        broken = FRAGMENT.replace(':initial :start', ':initial :missing')
        node = ''':run
  {:type :fragment
   :fragment "contract-fragment"
   :inputs {:repo-root "."}
   :parameters {:retries 1}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :again}]}
  :again
  {:type :fragment
   :fragment "contract-fragment"
   :inputs {:repo-root "."}
   :parameters {:retries 1}
   :transitions [{:when {:fragment/outcome "pass"} :next :done}
                 {:when {:fragment/outcome "fail"} :next :fail}]}'''
        wf = write_project(tmp, package_text=broken, workflow_node=node)
        status, payload = lint(wf, home)
        got = codes(payload)
        assert status != 0, payload
        assert "fragment-internal-lint-failed" in got, payload
        assert sum(1 for d in payload["diagnostics"] if d["code"] == "fragment-internal-lint-failed") == 1, payload
        assert "run" not in payload.get("fragment-inclusions", {}), payload
        assert "again" not in payload.get("fragment-inclusions", {}), payload
    with_tmp(run)


def test_import_allows_authoring_stub_with_required_parameter_pending():
    def run(tmp):
        home = tmp / "global-home"
        wf = write_project(tmp, workflow_node=''':run {:type :terminal :status :success}''')
        package_path = tmp / ".tesseraft/fragments/contract-fragment/fragment.edn"
        proc = tesseraft(["fragment", "import", str(package_path), str(wf), "--as", "imported"], home)
        assert proc.returncode == 0, proc.stderr
        imported = wf.read_text()
        assert ":imported" in imported, imported
        assert ":parameters" not in imported or ":retries" not in imported, imported
    with_tmp(run)


if __name__ == "__main__":
    test_effective_inclusion_contract_is_inspectable_and_defaults_are_merged()
    test_explicit_project_scope_does_not_fall_back_to_global()
    test_missing_and_nil_fragment_identity_are_invalid_names_not_unknown_packages()
    test_default_resolution_prefers_project_then_global_then_examples()
    test_explicit_scope_values_and_aliases_select_canonical_scope()
    test_version_binding_type_name_and_prefix_diagnostics_are_distinct()
    test_wrong_scalar_literals_and_unsupported_declared_types_fail_without_coercion()
    test_missing_scalar_types_are_rejected_before_effective_inclusion_data()
    test_invalid_binding_names_and_normalization_collisions_are_rejected_precisely()
    test_prefix_validation_rejects_dot_segments_and_windows_drive_forms()
    test_fragment_name_must_be_single_safe_package_name_and_stay_under_scope_root()
    test_resolved_package_metadata_name_must_match_requested_fragment()
    test_malformed_binding_containers_and_contract_entries_are_rejected()
    test_repeated_broken_package_inclusions_never_emit_effective_data()
    test_import_allows_authoring_stub_with_required_parameter_pending()
