import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { WorkflowGraph, formatCondition } from '../web/src/components/WorkflowGraph.tsx';
import { layoutGraph } from '../web/src/lib/graphLayout.ts';
import { StartWorkflowWizard } from '../web/src/components/StartWorkflowWizard.tsx';

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

test('Run component sources expose attempt, artifact, failure, and resource inspection surfaces', () => {
  const runPanels = fs.readFileSync('web/src/components/RunPanels.tsx', 'utf8');
  const artifactBrowser = fs.readFileSync('web/src/components/ArtifactBrowser.tsx', 'utf8');
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const workflowGraph = fs.readFileSync('web/src/components/WorkflowGraph.tsx', 'utf8');
  assert.match(workflowGraph, /JSON\.stringify\(node, null, 2\)/);
  assert.match(workflowGraph, />Resources</);
  assert.match(workflowGraph, /JSON\.stringify\(node\.resources, null, 2\)/);
  assert.match(runPanels, /Attempt timeline/);
  assert.match(artifactBrowser, /Artifact browser/);
  assert.match(runPanels, /Issues to inspect/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/artifacts/);
});

test('Git user UI source exposes a config tab reading and writing the git user identity', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const panel = fs.readFileSync('web/src/components/GitUserPanel.tsx', 'utf8');
  const api = fs.readFileSync('web/src/lib/api.ts', 'utf8');
  assert.match(app, /'git-user'/);
  assert.match(app, />Git user <span>config<\/span><\/button>/);
  assert.match(app, /<GitUserPanel \/>/);
  assert.match(app, /activeTab !== 'pi-sessions' && activeTab !== 'git-user'/);
  assert.match(panel, /Git user settings/);
  assert.match(panel, /\.tesseraft\/git-user\.json/);
  assert.match(panel, /\/api\/git-user/);
  assert.match(panel, /putJson<GitUserResponse>\('\/api\/git-user'/);
  assert.match(panel, /Save git user/);
  assert.match(panel, /Source/);
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
});

test('App and RunControls expose tabs, warnings, SSE updates, wizard, and POST routes', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const controls = fs.readFileSync('web/src/components/RunControls.tsx', 'utf8');
  const wizard = fs.readFileSync('web/src/components/StartWorkflowWizard.tsx', 'utf8');
  const api = fs.readFileSync('web/src/lib/api.ts', 'utf8');
  const workflowPanels = fs.readFileSync('web/src/components/WorkflowPanels.tsx', 'utf8');
  const runPanels = fs.readFileSync('web/src/components/RunPanels.tsx', 'utf8');
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
  assert.match(controls, /deleteJson<MutationResult>\(`\/api\/runs\/\${encodeURIComponent\(selectedRun/);
  assert.match(controls, /isDeletableLiveness/);
  assert.match(runPanels, /Show only deletable runs/);
  assert.match(controls, /Confirm one local node execution/);
  assert.match(workflowPanels, /aria-current=\{selected \? 'true' : undefined\}/);
  assert.match(runPanels, /aria-current=\{selected \? 'true' : undefined\}/);
  assert.match(runPanels, /status-pill/);
  // Start still goes through POST /api/runs from RunControls' onStart callback.
  assert.match(controls, /postJson<MutationResult>\('\/api\/runs'/);
  assert.match(controls, /max_steps: maxSteps/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/step/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/resume/);
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