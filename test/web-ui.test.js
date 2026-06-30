import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { WorkflowGraph, formatCondition } from '../web/src/components/WorkflowGraph.tsx';
import { layoutGraph } from '../web/src/lib/graphLayout.ts';

test('layoutGraph produces deterministic visual positions and edges', () => {
  const layout = layoutGraph([
    { id: 'start', type: 'prompt', title: 'Start' },
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
  assert.match(runPanels, /Attempt timeline/);
  assert.match(artifactBrowser, /Artifact browser/);
  assert.match(runPanels, /Failure \/ issues/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/artifacts/);
});

test('App and RunControls expose tabs, warnings, auto-refresh, and POST routes', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const controls = fs.readFileSync('web/src/components/RunControls.tsx', 'utf8');
  assert.match(app, /Run Console sections/);
  assert.match(app, />Workflows<\/button>/);
  assert.match(app, />Runs<\/button>/);
  assert.match(controls, /Run controls/);
  assert.match(controls, /Local mutation warning/);
  assert.match(app, /Active runs auto-refresh/);
  assert.match(app, /window\.setInterval/);
  assert.match(controls, /Non-smoke workflows may run agents, processes, or other side effects/);
  assert.match(controls, /I understand this may execute local side effects/);
  assert.match(controls, /Confirm one local node execution/);
  assert.match(controls, /postJson<MutationResult>\('\/api\/runs'/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/step/);
  assert.match(controls, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/resume/);
});
