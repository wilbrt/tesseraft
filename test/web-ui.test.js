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

test('App source exposes Run Console attempt, artifact, and failure surfaces', () => {
  const source = fs.readFileSync('web/src/App.tsx', 'utf8');
  assert.match(source, /Attempt timeline/);
  assert.match(source, /Artifact browser/);
  assert.match(source, /Failure \/ issues/);
  assert.match(source, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/artifacts/);
});

test('App source exposes local mutation controls with warnings and POST routes', () => {
  const source = fs.readFileSync('web/src/App.tsx', 'utf8');
  assert.match(source, /Run controls/);
  assert.match(source, /Local mutation warning/);
  assert.match(source, /Non-smoke workflows may run agents, processes, or other side effects/);
  assert.match(source, /I understand this may execute local side effects/);
  assert.match(source, /Confirm one local node execution/);
  assert.match(source, /postJson<MutationResult>\('\/api\/runs'/);
  assert.match(source, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/step/);
  assert.match(source, /\/api\/runs\/\$\{encodeURIComponent\(selectedRun \|\| ''\)\}\/resume/);
});
