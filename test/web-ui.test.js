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

test('layoutGraph produces deterministic visual positions and preserves node resources', () => {
  const layout = layoutGraph([
    { id: 'start', type: 'prompt', title: 'Start', resources: { requires: [{ kind: 'input', name: 'prompt' }] } },
    { id: 'done', type: 'terminal', title: 'Done' }
  ], [
    { from: 'start', to: 'done', condition: { else: true } }
  ]);

  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 1);
  const start = layout.nodes.find((node) => node.id === 'start');
  const done = layout.nodes.find((node) => node.id === 'done');
  assert.ok(start);
  assert.ok(done);
  assert.ok(done.x > start.x);
  assert.deepEqual(start.resources, { requires: [{ kind: 'input', name: 'prompt' }] });
  assert.deepEqual(layout.edges[0].condition, { else: true });
});

test('formatCondition renders JSON condition values as safe strings', () => {
  assert.equal(formatCondition({ else: true }), '{"else":true}');
  assert.equal(formatCondition('ok'), 'ok');
  assert.equal(formatCondition(false), '');
});

test('WorkflowGraph renders an SVG graph with clickable node details affordances', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkflowGraph, {
    nodes: [
      { id: 'start', type: 'prompt', title: 'Start', outputs: { next: 'done' } },
      { id: 'done', type: 'terminal', title: 'Done' }
    ],
    edges: [{ from: 'start', to: 'done', condition: { else: true } }]
  }));

  assert.match(markup, /<svg/);
  assert.match(markup, /Visual workflow node and edge graph/);
  assert.match(markup, /Open node start details/);
  assert.match(markup, /<line/);
  assert.match(markup, /Graph edges/);
  assert.match(markup, /\{&quot;else&quot;:true\}/);
});

test('WorkflowGraph marks selected nodes for run correlation', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkflowGraph, {
    selectedNodeId: 'start',
    nodes: [
      { id: 'start', type: 'prompt', title: 'Start' },
      { id: 'done', type: 'terminal', title: 'Done' }
    ],
    edges: [{ from: 'start', to: 'done' }]
  }));

  assert.match(markup, /graph-node selected/);
});

test('WorkflowGraph marks the run active node with a distinct active class', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkflowGraph, {
    selectedNodeId: 'done',
    activeNodeId: 'start',
    nodes: [
      { id: 'start', type: 'prompt', title: 'Start' },
      { id: 'done', type: 'terminal', title: 'Done' }
    ],
    edges: [{ from: 'start', to: 'done' }]
  }));
  // Active and selected are independent highlights; both classes appear.
  assert.match(markup, /graph-node active/);
  assert.match(markup, /graph-node selected/);

  // When a node is both active and selected, both classes apply on the same node.
  const both = renderToStaticMarkup(React.createElement(WorkflowGraph, {
    selectedNodeId: 'start',
    activeNodeId: 'start',
    nodes: [{ id: 'start', type: 'prompt', title: 'Start' }],
    edges: []
  }));
  assert.match(both, /graph-node selected active/);
});

test('runDurationLabel and isFinishedRun derive run view fields null-safely', () => {
  assert.equal(runDurationLabel({}), '—');
  assert.equal(runDurationLabel({ created_at: 'not-a-date' }), '—');
  assert.equal(isFinishedRun({ liveness: 'done' }), true);
  assert.equal(isFinishedRun({ liveness: 'executing' }), false);
  assert.equal(isFinishedRun({ liveness: null, status: 'error' }), true);
  assert.equal(isFinishedRun({ status: 'running' }), false);
});

test('RunListTable renders a centered table with search, show-finished toggle, and expandable rows', () => {
  const runs = {
    data: [
      { run_id: 'r1', workflow_name: 'smoke-demo', status: 'running', liveness: 'executing', state: 'start', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:02:13Z', staleness_seconds: null },
      { run_id: 'r2', workflow_name: 'smoke-demo', status: 'done', liveness: 'done', state: 'done', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:01:00Z', staleness_seconds: null }
    ],
    error: null
  };
  const markup = renderToStaticMarkup(React.createElement(RunListTable, {
    runs,
    expandedRunId: null,
    runDetail: null,
    events: [],
    artifacts: [],
    runError: null,
    selectedNodeId: null,
    lastRunRefresh: null,
    onToggleRow: () => {},
    onSelectNode: () => {}
  }));
  assert.match(markup, /<table/);
  assert.match(markup, /<th scope="col">Run<\/th>/);
  assert.match(markup, /Search runs/);
  assert.match(markup, /Show finished runs/);
  // Default hides finished runs; only r1 should be rendered as data row.
  assert.match(markup, /r1/);
  assert.doesNotMatch(markup, /<code>r2<\/code>/);
  assert.match(markup, /2m13s/);
});

test('Run component sources expose attempt, artifact, failure, and resource inspection surfaces', () => {
  const runPanels = fs.readFileSync('web/src/components/RunPanels.tsx', 'utf8');
  const runListTable = fs.readFileSync('web/src/components/RunListTable.tsx', 'utf8');
  const runInspection = fs.readFileSync('web/src/components/RunInspection.tsx', 'utf8');
  const artifactBrowser = fs.readFileSync('web/src/components/ArtifactBrowser.tsx', 'utf8');
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const workflowGraph = fs.readFileSync('web/src/components/WorkflowGraph.tsx', 'utf8');
  // WorkflowGraph still ships its default JSON detail view for Workflow Studio.
  assert.match(workflowGraph, /JSON\.stringify\(node, null, 2\)/);
  assert.match(workflowGraph, />Resources</);
  assert.match(workflowGraph, /JSON\.stringify\(node\.resources, null, 2\)/);
  assert.match(runPanels, /Attempt timeline/);
  assert.match(artifactBrowser, /Artifact browser/);
  assert.match(runPanels, /Issues to inspect/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/artifacts/);
  // Run view overhaul: in-place expandable table, search, show-finished, active node.
  assert.match(runListTable, /Show finished runs/);
  assert.match(runListTable, /Show only deletable runs/);
  assert.match(runListTable, /aria-current=\{expanded \? 'true' : undefined\}/);
  assert.match(runListTable, /status-pill/);
  assert.match(runListTable, /aria-expanded=\{expanded\}/);
  assert.match(runInspection, /activeNodeId/);
  assert.match(runInspection, /renderNodeDetail/);
  assert.match(runInspection, /Latest attempt/);
  assert.match(runInspection, /Related events/);
});

test('Settings UI source exposes a config tab reading and writing settings plus git identity', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const panel = fs.readFileSync('web/src/components/SettingsPanel.tsx', 'utf8');
  const gitUserPanel = fs.readFileSync('web/src/components/GitUserPanel.tsx', 'utf8');
  const api = fs.readFileSync('web/src/lib/api.ts', 'utf8');
  assert.match(app, /'settings'/);
  assert.match(app, />Settings <span>config<\/span><\/button>/);
  assert.match(app, /<SettingsPanel \/>/);
  assert.match(app, /activeTab !== 'pi-sessions' && activeTab !== 'settings'/);
  // The settings tab embeds the git identity fields and posts to /api/git-user.
  assert.match(panel, /Settings/);
  assert.match(panel, /\.tesseraft\/settings\.json/);
  assert.match(panel, /\/api\/settings/);
  assert.match(panel, /putJson<SettingsResponse>\(projectApiUrl\('\/api\/settings'/);
  assert.match(panel, /Default provider/);
  assert.match(panel, /Default model/);
  assert.match(panel, /GitHub token/);
  assert.match(panel, /Jira token/);
  assert.match(panel, /Default repo root/);
  assert.match(panel, /Save settings/);
  assert.match(panel, /Source/);
  assert.match(panel, /Git identity/);
  assert.match(panel, /<ConnectionsDoctorPanel \/>/);
  const doctor = fs.readFileSync('web/src/components/ConnectionsDoctorPanel.tsx', 'utf8');
  assert.match(doctor, /Connections Doctor/);
  assert.match(doctor, /\/api\/projects\/\$\{encodeURIComponent\(projectId \|\| 'default'\)\}\/doctor/);
  assert.match(doctor, /Run checks/);
  assert.match(doctor, /ready/);
  assert.match(doctor, /not-configured/);
  assert.match(doctor, /unreachable/);
  assert.match(doctor, /invalid/);
  assert.match(doctor, /Static configuration/);
  assert.match(doctor, /Read-only check/);
  assert.doesNotMatch(doctor, /preview|stdout|stderr|GH_TOKEN|GITHUB_TOKEN|JIRA_TOKEN/);
  assert.match(panel, /\/api\/git-user/);
  // GitUserPanel is still present and unchanged (git-user.json contract preserved).
  assert.match(gitUserPanel, /Git user settings/);
  assert.match(gitUserPanel, /\.tesseraft\/git-user\.json/);
  assert.match(api, /export const putJson = async <T,>/);
});

test('Pi sessions UI source exposes tab, chat UI, SSE stream, prompt form, refresh, and diagnostics', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const panel = fs.readFileSync('web/src/components/PiSessionsPanel.tsx', 'utf8');
  assert.match(app, /'pi-sessions'/);
  assert.match(app, />Pi Sessions <span>chat<\/span><\/button>/);
  assert.match(app, /<PiSessionsPanel \/>/);
  assert.match(panel, /real Pi SDK by default/);
  assert.match(panel, /TESSERAFT_PI_ADAPTER=fake/);
  assert.match(panel, /\/api\/pi-sessions/);
  assert.match(panel, /new EventSource/);
  assert.match(panel, /\/api\/pi-sessions\/\$\{encodeURIComponent\(selectedSessionId\)\}\/stream/);
  assert.match(panel, /\/api\/pi-sessions\/\$\{encodeURIComponent\(selectedSessionId\)\}\/prompts/);
  assert.match(panel, /Pi session chat/);
  assert.match(panel, /Pi session chat transcript/);
  assert.match(panel, /Diagnostics: raw Pi session events/);
  assert.match(panel, /Refresh sessions/);
  assert.match(panel, /Refresh chat/);
  assert.doesNotMatch(panel, /Events \/ output/);
  assert.match(panel, /Send prompt/);
  // Create-flow failures (e.g. pi_settings_resolution) must surface as a
  // visible, assertive inline error anchored near the action, not be dropped.
  assert.match(panel, /pi-session-create-error/);
  assert.match(panel, /role="alert" aria-live="assertive"/);
  const createSession = panel.match(/const createSession = async[\s\S]*?^  };/m);
  assert.ok(createSession, 'createSession handler present');
  assert.match(createSession[0], /try \{[\s\S]*\/api\/pi-sessions[\s\S]*\} catch/);
  assert.match(createSession[0], /setCreateError\(/);
});

test('Artifact comments and approval UI sources expose annotation and decision surfaces', () => {
  const artifactBrowser = fs.readFileSync('web/src/components/ArtifactBrowser.tsx', 'utf8');
  const approvalPanel = fs.readFileSync('web/src/components/ApprovalPanel.tsx', 'utf8');
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const types = fs.readFileSync('web/src/types/runConsole.ts', 'utf8');
  const api = fs.readFileSync('web/src/lib/api.ts', 'utf8');
  // Comments pane keyed by artifact path with line-range anchors.
  assert.match(artifactBrowser, /Comments on/);
  assert.match(artifactBrowser, /Add a comment anchored to this artifact/);
  assert.match(artifactBrowser, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/comments/);
  assert.match(artifactBrowser, /postJson\(projectApiUrl\(`\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/comments`/);
  assert.match(artifactBrowser, /start_line/);
  // Approval decision panel wired into Run Console.
  assert.match(approvalPanel, /Manual input · approval/);
  assert.match(approvalPanel, /run is paused at an approval node/);
  assert.match(approvalPanel, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/approvals/);
  assert.match(approvalPanel, /postJson<{/);
  // ApprovalPanel is rendered for the selected run in the runs tab.
  assert.match(app, /<ApprovalPanel runId=\{selectedRun\} onRefresh=\{refreshAfterMutation\}/);
  // Types for the new surfaces.
  assert.match(types, /export type Comment =/);
  assert.match(types, /export type ApprovalRequest =/);
  assert.match(types, /export type ApprovalsResponse =/);
  assert.match(types, /export type ApprovalDecisionOption =/);
  assert.match(types, /export type ApprovalRouting =/);
  assert.match(api, /export const postJson/);
  // P0.2 presentation contract: the panel renders decision options from the
  // durable approval record's `decisions` list, not a hard-coded array, with
  // a backward-compatible fallback for older records.
  assert.match(approvalPanel, /approval\?\.decisions/);
  assert.match(approvalPanel, /approval\.question/);
  assert.match(approvalPanel, /approval\.artifacts/);
  assert.match(approvalPanel, /approval\.routing/);
  assert.match(approvalPanel, /Manual input · approval/);
});

test('App and RunControls expose tabs, warnings, SSE updates, wizard, and POST routes', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const controls = fs.readFileSync('web/src/components/RunControls.tsx', 'utf8');
  const wizard = fs.readFileSync('web/src/components/StartWorkflowWizard.tsx', 'utf8');
  const api = fs.readFileSync('web/src/lib/api.ts', 'utf8');
  const workflowPanels = fs.readFileSync('web/src/components/WorkflowPanels.tsx', 'utf8');
  const runPanels = fs.readFileSync('web/src/components/RunPanels.tsx', 'utf8');
  const runListTable = fs.readFileSync('web/src/components/RunListTable.tsx', 'utf8');
  assert.match(app, /Run Console sections/);
  assert.match(app, /Tesseraft Console/);
  assert.match(app, /Current console context/);
  assert.match(app, /No workflow selected/);
  assert.match(app, /No run selected/);
  assert.match(app, /No node selected/);
  assert.match(app, />Workflows <span>inspect<\/span><\/button>/);
  assert.match(app, />Runs <span>operate<\/span><\/button>/);
  assert.match(app, />Pi Sessions <span>chat<\/span><\/button>/);
  // App passes the discovered workflows list into RunControls for the wizard picker.
  assert.match(app, /workflows=\{workflows\.data\}/);
  assert.match(controls, /Run controls/);
  assert.match(controls, /Run control context/);
  assert.match(controls, /Start the selected workflow, or operate the selected run/);
  assert.match(controls, /Local mutation warning/);
  assert.match(app, /Streaming ·/);
  assert.match(app, /new EventSource/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun\)\}\/stream/);
  assert.doesNotMatch(app, /window\.setInterval/);
  assert.match(controls, /Non-smoke workflows may run agents, processes, or other side effects/);
  assert.match(controls, /Not smoke-demo/);
  // The guided wizard (not the inline card) now owns input rendering.
  assert.match(controls, /StartWorkflowWizard/);
  assert.match(controls, />Start workflow<\/button>/);
  assert.doesNotMatch(controls, /key=value, one per line/);
  assert.doesNotMatch(controls, /parseInputs/);
  assert.match(controls, /Delete selected run/);
  assert.match(controls, /Confirm permanent deletion of this run's directory/);
  assert.match(controls, /deleteJson<MutationResult>\(projectApiUrl\(`\/api\/runs\/\${encodeURIComponent\(selectedRun/);
  assert.match(controls, /isDeletableLiveness/);
  assert.match(runListTable, /Show only deletable runs/);
  assert.match(controls, /Confirm one local node execution/);
  assert.match(workflowPanels, /aria-current=\{selected \? 'true' : undefined\}/);
  assert.match(runListTable, /aria-current=\{expanded \? 'true' : undefined\}/);
  assert.match(runListTable, /status-pill/);
  // Start still goes through POST /api/runs from RunControls' onStart callback.
  assert.match(controls, /postJson<MutationResult>\(projectApiUrl\('\/api\/runs'/);
  assert.match(controls, /max_steps: maxSteps/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/step/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/resume/);
  assert.match(controls, /Cancel selected run/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/cancel/);
  // Wizard owns the guided start flow and type-correct inputs.
  assert.match(wizard, /Start workflow/);
  assert.match(wizard, /Workflow inputs/);
  assert.match(wizard, /workflowDetail\?\.normalized\?\.inputs/);
  assert.match(wizard, /type === 'boolean'/);
  assert.match(wizard, /type === 'integer'/);
  assert.match(wizard, /type === 'path'/);
  assert.match(wizard, /PathPicker/);
  assert.match(wizard, /browsePath/);
  assert.match(wizard, /\/api\/browse/);
  assert.match(wizard, /Required inputs missing/);
  assert.match(wizard, /I understand this may execute local side effects automatically/);
  assert.match(wizard, /role="dialog"/);
  assert.match(wizard, /aria-modal/);
  assert.match(api, /export const browsePath = async/);
  // WW-1: focus/keydown handling must not re-mount on every parent render while
  // the wizard is open during SSE-driven re-renders. onClose is read from a ref
  // and the focus-management effect depends only on [open].
  assert.match(wizard, /onCloseRef/);
  assert.match(wizard, /\}, \[open\]\);/);
  // WW-2: a guarded or failed POST /api/runs must reject onStart so the wizard
  // stays open and preserves configured inputs, rather than closing silently.
  assert.match(controls, /data\.status === 'guarded'/);
  assert.match(controls, /Run start was guarded/);
});

test('project overlays portal outside clipping layout and Settings owns the full page surface', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const selector = fs.readFileSync('web/src/components/ProjectSelector.tsx', 'utf8');
  const popover = fs.readFileSync('web/src/components/Popover.tsx', 'utf8');
  const settings = fs.readFileSync('web/src/components/SettingsPanel.tsx', 'utf8');
  const styles = fs.readFileSync('web/src/style.css', 'utf8');
  assert.match(popover, /createPortal/);
  assert.match(popover, /position/);
  assert.match(selector, /data-testid="project-selector-menu"/);
  assert.match(selector, /aria-haspopup="listbox"/);
  assert.doesNotMatch(styles, /\.header-topline[^\n]*overflow-x:\s*hidden/);
  assert.match(styles, /\.popover-layer\s*\{[^}]*position:\s*fixed/);
  assert.match(app, /<FullWidthPage><SettingsPanel\s*\/><\/FullWidthPage>/);
  assert.match(settings, /settings-layout/);
  assert.match(styles, /\.settings-layout\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
});

test('Workflow Studio UI source exposes canvas, toolbar, context menus, and save modes (design doc)', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const studio = fs.readFileSync('web/src/components/WorkflowStudio.tsx', 'utf8');
  const panels = fs.readFileSync('web/src/components/WorkflowPanels.tsx', 'utf8');
  const studioLib = fs.readFileSync('web/src/lib/studio.ts', 'utf8');
  const types = fs.readFileSync('web/src/types/studio.ts', 'utf8');
  // App exposes a Studio tab and renders WorkflowStudio.
  assert.match(app, /'studio'/);
  assert.match(app, /<WorkflowStudio /);
  assert.match(app, />Studio <span>author<\/span>/);
  // WorkflowPanels offers the create-workflow entry point and per-row Studio edit.
  assert.match(panels, /Create workflow/);
  assert.match(panels, /Edit .* in Studio/);
  // Studio component implements the toolbar with the three save/clear actions.
  assert.match(studio, /Add node/);
  assert.match(studio, /Save draft/);
  assert.match(studio, /Save completed/);
  assert.match(studio, /Clear canvas/);
  // Drag-to-move via pointer handlers.
  assert.match(studio, /onNodePointerDown/);
  assert.match(studio, /onSvgPointerMove/);
  // Node right-click context menu with Edit/Delete/Connect.
  assert.match(studio, /onNodeContextMenu/);
  assert.match(studio, /Connect/);
  assert.match(studio, /Delete/);
  // Edge right-click context menu with Edit when / Delete.
  assert.match(studio, /onEdgeContextMenu/);
  assert.match(studio, /Edit when/);
  // Save completed runs the linter and blocks on failure.
  assert.match(studio, /doSave\('completed'\)/);
  assert.match(studioLib, /saveStudioWorkflow/);
  assert.match(studioLib, /lintStudioWorkflow/);
  assert.match(studioLib, /\/api\/studio\/workflows/);
  assert.match(studioLib, /save_mode/);
  assert.match(studioLib, /'completed'/);
  // Node types per SPEC §5 are offered.
  assert.match(types, /:agent/);
  assert.match(types, /:terminal/);
  assert.match(types, /:router/);
});

test('Settings UI source exposes Projects list and Connections editor with masked tokens (surface 10)', () => {
  const panel = fs.readFileSync('web/src/components/SettingsPanel.tsx', 'utf8');
  // The Settings area renders a first-class Projects surface consuming the
  // /api/projects* endpoints, with masked credential state and credential-ref
  // editing that never sends raw tokens.
  assert.match(panel, /Projects/);
  assert.match(panel, /Connections/);
  assert.match(panel, /\/api\/projects/);
  assert.match(panel, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}/);
  assert.match(panel, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/connections/);
  assert.match(panel, /loadProjects/);
  assert.match(panel, /ProjectsResponse/);
  assert.match(panel, /ProjectConnectionsResponse/);
  // Masked credential state is rendered (never raw tokens).
  assert.match(panel, /credential_state/);
  assert.match(panel, /credential-ref/);
  assert.match(panel, /status-pill connected/);
  assert.match(panel, /status-pill disconnected/);
  // The connections editor only ever sends credential_ref / base_url, never raw
  // token payloads (the server rejects them — surface-4 gate).
  assert.match(panel, /NEVER send raw token payloads/);
  assert.match(panel, /credential_ref/);
  assert.match(panel, /saveConnections/);
  assert.match(panel, /env:GITHUB_TOKEN/);
  assert.match(panel, /env:JIRA_TOKEN/);
  assert.match(panel, /aria-label="Projects and connections"/);
  assert.match(panel, /aria-label="Projects list"/);
  assert.match(panel, /aria-label="Project metadata"/);
});

test('StartWorkflowWizard renders a two-step modal with a workflow picker', () => {
  const onStart = async () => ({ operation: 'start' });
  const markup = renderToStaticMarkup(React.createElement(StartWorkflowWizard, {
    open: true,
    workflows: [{ name: 'smoke-demo', path: 'examples/smoke/workflow.edn' }],
    initialWorkflow: 'smoke-demo',
    onClose: () => {},
    onStart
  }));
  assert.match(markup, /Start workflow/);
  assert.match(markup, /Pick workflow/);
  assert.match(markup, /Configure run/);
  assert.match(markup, /smoke-demo/);
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
});
