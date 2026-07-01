import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { WorkflowGraph, formatCondition } from '../web/src/components/WorkflowGraph.tsx';
import { layoutGraph } from '../web/src/lib/graphLayout.ts';

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

test('Run component sources expose attempt, artifact, and failure surfaces', () => {
  const runPanels = fs.readFileSync('web/src/components/RunPanels.tsx', 'utf8');
  const artifactBrowser = fs.readFileSync('web/src/components/ArtifactBrowser.tsx', 'utf8');
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const workflowGraph = fs.readFileSync('web/src/components/WorkflowGraph.tsx', 'utf8');
  assert.match(workflowGraph, /JSON\.stringify\(node, null, 2\)/);
  assert.match(runPanels, /Attempt timeline/);
  assert.match(artifactBrowser, /Artifact browser/);
  assert.match(runPanels, /Issues to inspect/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/artifacts/);
});

test('Pi sessions UI source exposes tab, chat UI, SSE stream, prompt form, refresh, and diagnostics', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const panel = fs.readFileSync('web/src/components/PiSessionsPanel.tsx', 'utf8');
  assert.match(app, /'pi-sessions'/);
  assert.match(app, />Pi Sessions<\/button>/);
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

test('App and RunControls expose tabs, warnings, SSE updates, and POST routes', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const controls = fs.readFileSync('web/src/components/RunControls.tsx', 'utf8');
  assert.match(app, /Run Console sections/);
  assert.match(app, />Workflows<\/button>/);
  assert.match(app, />Runs<\/button>/);
  assert.match(app, />Pi Sessions<\/button>/);
  assert.match(controls, /Run controls/);
  assert.match(controls, /Local mutation warning/);
  assert.match(app, /Active runs stream updates/);
  assert.match(app, /new EventSource/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun\)\}\/stream/);
  assert.doesNotMatch(app, /window\.setInterval/);
  assert.match(controls, /Non-smoke workflows may run agents, processes, or other side effects/);
  assert.match(controls, /I understand this may execute local side effects automatically/);
  assert.match(controls, /Workflow inputs/);
  assert.match(controls, /workflowDetail\?\.normalized\?\.inputs/);
  assert.match(controls, /type === 'boolean'/);
  assert.match(controls, /type=\"number\"/);
  assert.match(controls, /Required inputs missing/);
  assert.doesNotMatch(controls, /key=value, one per line/);
  assert.doesNotMatch(controls, /parseInputs/);
  assert.match(controls, /Confirm one local node execution/);
  assert.match(controls, /postJson<MutationResult>\('\/api\/runs'/);
  assert.match(controls, /max_steps: maxSteps/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/step/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/resume/);
});
