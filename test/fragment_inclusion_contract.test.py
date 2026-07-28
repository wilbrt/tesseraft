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


def write_project(tmp: Path, package_text=FRAGMENT, workflow_node=None, global_package=False):
    package_root = (tmp / ("global-home/fragments/contract-fragment" if global_package else ".tesseraft/fragments/contract-fragment"))
    package_root.mkdir(parents=True, exist_ok=True)
    (package_root / "fragment.edn").write_text(package_text)
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


def lint(wf: Path, home: Path):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    proc = subprocess.run(
        ["./bin/tesseraft", "lint", str(wf), "--format", "json"],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
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


if __name__ == "__main__":
    test_effective_inclusion_contract_is_inspectable_and_defaults_are_merged()
    test_explicit_project_scope_does_not_fall_back_to_global()
    test_version_binding_type_name_and_prefix_diagnostics_are_distinct()
    test_wrong_scalar_literals_and_unsupported_declared_types_fail_without_coercion()
