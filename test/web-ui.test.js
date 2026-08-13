import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { WorkflowGraph, formatCondition } from '../web/src/components/WorkflowGraph.tsx';
import { layoutGraph } from '../web/src/lib/graphLayout.ts';
import { StartWorkflowWizard } from '../web/src/components/StartWorkflowWizard.tsx';
import { RunListTable } from '../web/src/components/RunListTable.tsx';
import { runDurationLabel, isFinishedRun } from '../web/src/lib/runConsole.ts';
import { projectApiUrl } from '../web/src/lib/project.ts';

const source = (path) => fs.readFileSync(path, 'utf8');

test('feature API paths are project-scoped even for the default project', () => {
  assert.equal(projectApiUrl('/api/runs', 'default'), '/api/projects/default/runs');
  assert.equal(projectApiUrl('/api/workflows/demo', 'alpha'), '/api/projects/alpha/workflows/demo');
});

test('layoutGraph is deterministic and preserves resource contracts', () => {
  const layout = layoutGraph([
    { id: 'start', type: 'prompt', title: 'Start', resources: { requires: [{ kind: 'input', name: 'prompt' }] } },
    { id: 'done', type: 'terminal', title: 'Done' }
  ], [{ from: 'start', to: 'done', condition: { else: true } }]);
  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 1);
  assert.ok(layout.nodes.find((node) => node.id === 'done').x > layout.nodes.find((node) => node.id === 'start').x);
  assert.deepEqual(layout.nodes.find((node) => node.id === 'start').resources, { requires: [{ kind: 'input', name: 'prompt' }] });
});

test('formatCondition renders semantic condition values safely', () => {
  assert.equal(formatCondition({ else: true }), '{"else":true}');
  assert.equal(formatCondition('ok'), 'ok');
  assert.equal(formatCondition(false), '');
});

test('WorkflowGraph renders accessible selection and active-state affordances', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkflowGraph, {
    selectedNodeId: 'start', activeNodeId: 'start',
    nodes: [{ id: 'start', type: 'prompt', title: 'Start' }, { id: 'done', type: 'terminal', title: 'Done' }],
    edges: [{ from: 'start', to: 'done', condition: { else: true } }]
  }));
  assert.match(markup, /<svg/);
  assert.match(markup, /Visual workflow node and edge graph/);
  assert.match(markup, /Open node start details/);
  assert.match(markup, /graph-node selected active/);
  assert.match(markup, /Graph edges/);
});

test('run view helpers and expandable table remain null-safe', () => {
  assert.equal(runDurationLabel({}), '—');
  assert.equal(runDurationLabel({ created_at: 'not-a-date' }), '—');
  assert.equal(isFinishedRun({ liveness: 'done' }), true);
  assert.equal(isFinishedRun({ status: 'running' }), false);
  const markup = renderToStaticMarkup(React.createElement(RunListTable, {
    runs: { data: [
      { run_id: 'r1', workflow_name: 'smoke-demo', status: 'running', liveness: 'executing', state: 'start', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:02:13Z', staleness_seconds: null },
      { run_id: 'r2', workflow_name: 'smoke-demo', status: 'done', liveness: 'done', state: 'done', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:01:00Z', staleness_seconds: null }
    ], error: null },
    expandedRunId: null, runDetail: null, events: [], artifacts: [], runError: null,
    selectedNodeId: null, lastRunRefresh: null, onToggleRow: () => {}, onSelectNode: () => {}
  }));
  assert.match(markup, /Search runs/);
  assert.match(markup, /Show finished runs/);
  assert.match(markup, /r1/);
  assert.doesNotMatch(markup, /<code>r2<\/code>/);
});

test('App composes the console while useConsoleData owns reads and SSE state', () => {
  const app = source('web/src/App.tsx');
  const data = source('web/src/features/console/useConsoleData.ts');
  const controls = source('web/src/components/RunControls.tsx');
  assert.match(app, /useConsoleData/);
  assert.match(app, /<RunListTable/);
  assert.match(app, /<WorkflowStudio/);
  assert.match(app, /<SettingsPanel/);
  assert.doesNotMatch(app, /getJson|new EventSource/);
  assert.match(data, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/artifacts/);
  assert.match(data, /new EventSource/);
  assert.match(data, /\/stream/);
  assert.match(controls, /StartWorkflowWizard/);
  assert.match(controls, /Local mutation warning/);
  assert.match(controls, /Delete selected run/);
});

test('run inspection and comments stay focused while approvals get a context-first workspace', () => {
  const app = source('web/src/App.tsx');
  const runPanels = source('web/src/components/RunPanels.tsx');
  const inspection = source('web/src/components/RunInspection.tsx');
  const artifacts = source('web/src/components/ArtifactBrowser.tsx');
  const approvals = source('web/src/components/ApprovalInbox.tsx');
  assert.match(runPanels, /Attempt timeline/);
  assert.match(runPanels, /Issues to inspect/);
  assert.match(inspection, /Latest attempt/);
  assert.match(inspection, /Related events/);
  assert.match(artifacts, /Artifact browser/);
  assert.match(artifacts, /Comments on/);
  assert.match(artifacts, /start_line/);
  assert.match(app, /Approvals <span>review<\/span>/);
  assert.match(app, /<ApprovalInbox/);
  assert.match(approvals, /Approval inbox/);
  assert.match(approvals, /Approval evidence viewer/);
  assert.match(approvals, /artifact_line/);
  assert.match(approvals, /Resume the run immediately/);
  assert.doesNotMatch(approvals, /modal/i);
});

test('Settings composes one authority per concern', () => {
  const app = source('web/src/App.tsx');
  const settings = source('web/src/components/SettingsPanel.tsx');
  const git = source('web/src/components/GitUserPanel.tsx');
  const projects = source('web/src/features/settings/ProjectConnectionsPanel.tsx');
  const tracker = source('web/src/components/WorkTrackerPanel.tsx');
  const doctor = source('web/src/components/ConnectionsDoctorPanel.tsx');
  assert.match(app, />Settings <span>config<\/span><\/button>/);
  assert.match(settings, /User preferences/);
  assert.match(settings, /<GitUserPanel \/>/);
  assert.match(settings, /<ProjectConnectionsPanel \/>/);
  assert.match(settings, /<ConnectionsDoctorPanel \/>/);
  assert.doesNotMatch(settings, /WorkTrackerPanel|git-identities\.json|credential.*value/i);
  assert.match(git, /Git user settings/);
  assert.match(git, /identity service owns the user default and project override/);
  assert.match(projects, /Portable descriptors own project configuration/);
  assert.match(projects, /connections\.code-host|\['code-host'\]/);
  assert.match(projects, /<WorkTrackerPanel/);
  assert.match(tracker, /\/api\/work-tracker-providers/);
  assert.match(doctor, /Connections Doctor/);
  assert.match(doctor, /work_tracker/);
  assert.doesNotMatch(projects + tracker + doctor, /type="password"|raw token/i);
});

test('Workflow Studio is canvas orchestration over a pure reducer and focused dialogs', () => {
  const studio = source('web/src/components/WorkflowStudio.tsx');
  const model = source('web/src/features/studio/model.ts');
  const dialogs = source('web/src/features/studio/StudioDialogs.tsx');
  assert.match(studio, /useReducer\(studioDocumentReducer/);
  assert.match(studio, /studio-canvas/);
  assert.match(studio, /NodeFormModal/);
  assert.match(studio, /LintMessageList/);
  assert.match(model, /export const studioDocumentReducer/);
  assert.match(model, /case 'edit-node'/);
  assert.match(model, /case 'add-transition'/);
  assert.match(dialogs, /PromptComposerModal/);
  assert.match(dialogs, /EdgeMenu/);
  assert.doesNotMatch(studio + model + dialogs, /parseEdn|:deterministic|:agent|:terminal/);
});

test('Pi session UI keeps chat, SSE, and explicit fake-adapter diagnostics', () => {
  const app = source('web/src/App.tsx');
  const panel = source('web/src/components/PiSessionsPanel.tsx');
  assert.match(app, />Pi Sessions <span>chat<\/span><\/button>/);
  assert.match(panel, /TESSERAFT_PI_ADAPTER=fake/);
  assert.match(panel, /new EventSource/);
  assert.match(panel, /Pi session chat transcript/);
  assert.match(panel, /role="alert" aria-live="assertive"/);
  assert.match(panel, /Send prompt/);
});

test('StartWorkflowWizard renders a two-step modal with a workflow picker', () => {
  const markup = renderToStaticMarkup(React.createElement(StartWorkflowWizard, {
    open: true,
    workflows: [{ name: 'smoke-demo', title: 'Smoke demo', summary: 'Safe local smoke workflow.' }],
    selectedWorkflow: 'smoke-demo',
    workflowDetail: { name: 'smoke-demo', title: 'Smoke demo', metadata: {}, inputs: { prompt: { type: 'string', required: true } }, states: {}, raw: {} },
    onSelectWorkflow: () => {}, onClose: () => {}, onStarted: () => {}
  }));
  assert.match(markup, /Start workflow/);
  assert.match(markup, /Pick workflow/);
  assert.match(markup, /Configure run/);
  assert.match(markup, /smoke-demo/);
});
