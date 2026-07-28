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
 :metadata {:name "resource-fragment" :version "1.0.0"}
 :interface {:inputs {:repo-root {:type :string :required true}
                      :literal {:type :string :required false}}
             :parameters {:rounds {:type :integer :default 1}}
             :outputs {:status {:required true}
                       :issues {:required false}}
             :outcomes #{:pass :fail}}
 :requirements {:resources {:requires [{:kind :input :name :repo-root :path "repo" :mode :read}
                                        {:kind :artifact :name :config :path "config/settings.edn" :mode :read}]
                            :consumes [{:kind :artifact :name :ticket :path "ticket.json" :mode :read}]
                            :produces [{:kind :artifact :name :status :path "ignored/status.json"}
                                       {:kind :artifact :name :issues :path "ignored/issues.json"}]}}
 :fragment {:initial :start
            :exit [{:on :pass :produces {:status "status.json"}}
                   {:on :fail :produces {:status "status.json" :issues "issues.json"}}]
            :states {:start {:type :router
                             :resources {:produces [{:kind :artifact :name :internal-secret :path "private/secret.txt"}]}
                             :transitions [{:next :passed} {:next :failed}]}
                     :passed {:type :terminal :status :success :outcome :pass}
                     :failed {:type :terminal :status :failure :outcome :fail}}}}}
'''


def write_fragment_package(tmp: Path, text=FRAGMENT):
    package_root = tmp / ".tesseraft/fragments/resource-fragment"
    package_root.mkdir(parents=True, exist_ok=True)
    (package_root / "fragment.edn").write_text(text)


def write_workflow(tmp: Path, states: str, inputs='{:repo-root {:path "repo" :resource-name "workspace"}}', defaults='{}'):
    wf = tmp / "workflow.edn"
    workflow = '''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "fragment-boundary-resources"}
 :inputs INPUTS
 :defaults DEFAULTS
 :initial :prepare
 :states {STATES}}
'''
    wf.write_text(workflow.replace("INPUTS", inputs).replace("DEFAULTS", defaults).replace("STATES", states))
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
    tmp = Path(tempfile.mkdtemp(prefix="tesseraft-fi4-"))
    try:
        return fn(tmp)
    finally:
        shutil.rmtree(tmp)


def base_states(include_ticket=True, prefix="run-a", include_downstream=True):
    produced = '''{:kind :artifact :name :config :path "run-a/config/settings.edn"}'''
    if include_ticket:
        produced += ''' {:kind :artifact :name :ticket :path "run-a/ticket.json"}'''
    downstream = ''
    if include_downstream:
        downstream = ''':after {:type :deterministic
        :handler :noop/succeed
        :resources {:requires [{:kind :artifact :name :status :path "run-a/status.json" :mode :read}]}
        :next :done}
      :done {:type :terminal :status :success}'''
    else:
        downstream = ''':done {:type :terminal :status :success}'''
    return f''':prepare {{:type :deterministic
        :handler :noop/succeed
        :resources {{:produces [{produced}]}}
        :next :run}}
      :run {{:type :fragment
        :fragment "resource-fragment"
        :scope :project
        :prefix "{prefix}"
        :inputs {{:repo-root "{{{{inputs.repo-root}}}}"}}
        :transitions [{{:when {{:fragment/outcome "pass"}} :next :after}}
                      {{:when {{:fragment/outcome "fail"}} :next :after}}]}}
      {downstream}'''


def test_fragment_boundary_resources_are_inspectable_and_drive_flow():
    def run(tmp):
        write_fragment_package(tmp)
        wf = write_workflow(tmp, base_states())
        status, payload = lint(wf, tmp / "home")
        assert status == 0, payload
        resources = payload["fragment-inclusions"]["run"]["resources"]
        assert resources["requires"] == [
            {"kind": "input", "name": "workspace", "path": "repo", "mode": "read"},
            {"kind": "artifact", "name": "config", "path": "run-a/config/settings.edn", "mode": "read"},
        ], resources
        assert resources["consumes"] == [
            {"kind": "artifact", "name": "ticket", "path": "run-a/ticket.json", "mode": "read"}
        ], resources
        assert resources["produces"] == [
            {"kind": "artifact", "name": "status", "path": "run-a/status.json"}
        ], resources
        assert "issues" not in {r["name"] for r in resources["produces"]}, resources
        assert "internal-secret" not in json.dumps(resources), resources
    with_tmp(run)


def test_missing_projected_incoming_resource_fails_at_inclusion_boundary():
    def run(tmp):
        write_fragment_package(tmp)
        wf = write_workflow(tmp, base_states(include_ticket=False))
        status, payload = lint(wf, tmp / "home")
        assert status != 0, payload
        missing = [d for d in payload["diagnostics"] if d["code"] == "resource-missing-producer"]
        assert missing, payload
        assert missing[0]["path"] == ["states", "run", "resources", "consumes", 0], payload
    with_tmp(run)


def test_literal_input_binding_does_not_invent_external_prerequisite():
    def run(tmp):
        write_fragment_package(tmp)
        states = base_states().replace(':inputs {:repo-root "{{inputs.repo-root}}"}', ':inputs {:repo-root "literal/path"}')
        wf = write_workflow(tmp, states, inputs='{}')
        status, payload = lint(wf, tmp / "home")
        assert status == 0, payload
        reqs = payload["fragment-inclusions"]["run"]["resources"]["requires"]
        assert reqs == [{"kind": "artifact", "name": "config", "path": "run-a/config/settings.edn", "mode": "read"}], reqs
    with_tmp(run)


def test_pathless_workflow_input_alias_drops_fragment_boundary_path():
    def run(tmp):
        write_fragment_package(tmp)
        wf = write_workflow(tmp, base_states(), inputs='{:repo-root {}}')
        status, payload = lint(wf, tmp / "home")
        assert status == 0, payload
        reqs = payload["fragment-inclusions"]["run"]["resources"]["requires"]
        assert reqs[0] == {"kind": "input", "name": "repo-root", "mode": "read"}, reqs
    with_tmp(run)


def test_pathless_workflow_default_alias_drops_fragment_boundary_path():
    def run(tmp):
        write_fragment_package(tmp)
        states = base_states().replace('{{inputs.repo-root}}', '{{defaults.repo-root}}')
        wf = write_workflow(tmp, states, inputs='{}', defaults='{:repo-root {}}')
        status, payload = lint(wf, tmp / "home")
        assert status == 0, payload
        reqs = payload["fragment-inclusions"]["run"]["resources"]["requires"]
        assert reqs[0] == {"kind": "default", "name": "repo-root", "mode": "read"}, reqs
    with_tmp(run)


def test_two_prefixed_inclusions_project_distinct_outputs_without_mutating_authored_nodes():
    def run(tmp):
        write_fragment_package(tmp)
        states = ''':prepare {:type :deterministic
        :handler :noop/succeed
        :resources {:produces [{:kind :artifact :name :config :path "a/config/settings.edn"}
                               {:kind :artifact :name :ticket :path "a/ticket.json"}
                               {:kind :artifact :name :config :path "b/config/settings.edn"}
                               {:kind :artifact :name :ticket :path "b/ticket.json"}]}
        :next :run-a}
      :run-a {:type :fragment :fragment "resource-fragment" :scope :project :prefix "a"
        :inputs {:repo-root "{{inputs.repo-root}}"}
        :transitions [{:when {:fragment/outcome "pass"} :next :run-b}
                      {:when {:fragment/outcome "fail"} :next :run-b}]}
      :run-b {:type :fragment :fragment "resource-fragment" :scope :project :prefix "b"
        :inputs {:repo-root "{{inputs.repo-root}}"}
        :transitions [{:when {:fragment/outcome "pass"} :next :after}
                      {:when {:fragment/outcome "fail"} :next :after}]}
      :after {:type :deterministic :handler :noop/succeed
        :resources {:requires [{:kind :artifact :name :status :path "a/status.json" :mode :read}
                               {:kind :artifact :name :status :path "b/status.json" :mode :read}]}
        :next :done}
      :done {:type :terminal :status :success}'''
        wf = write_workflow(tmp, states)
        before = wf.read_text()
        status, payload = lint(wf, tmp / "home")
        assert status == 0, payload
        inclusions = payload["fragment-inclusions"]
        assert inclusions["run-a"]["resources"]["produces"][0]["path"] == "a/status.json", inclusions
        assert inclusions["run-b"]["resources"]["produces"][0]["path"] == "b/status.json", inclusions
        assert wf.read_text() == before
    with_tmp(run)


if __name__ == "__main__":
    test_fragment_boundary_resources_are_inspectable_and_drive_flow()
    test_missing_projected_incoming_resource_fails_at_inclusion_boundary()
    test_literal_input_binding_does_not_invent_external_prerequisite()
    test_pathless_workflow_input_alias_drops_fragment_boundary_path()
    test_pathless_workflow_default_alias_drops_fragment_boundary_path()
    test_two_prefixed_inclusions_project_distinct_outputs_without_mutating_authored_nodes()
