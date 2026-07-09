// P1.1 — Expose scope and shadowing metadata in workflow discovery.
//
// These tests assert the control-plane list/detail endpoints surface
// `source`, `precedence`, `conflicts`, and `duplicates` metadata *without*
// changing discovery precedence semantics (the visible workflow set is
// unchanged; one winner per name at max precedence). They use temp dirs for
// `--workspace-root`, `--tesseraft-home`, and `--workflow-root` so the
// developer's real `~/.tesseraft` is never read. Modeled on
// `test/web-server.test.js`'s `execFileSync` discovery test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workflowEdn = (name, title) => [
  '{:api-version "tesseraft.workflow/v1"',
  ' :kind :workflow',
  ` :metadata {:name "${name}" :title "${title}"}`,
  ' :initial :done',
  ' :states {:done {:type :terminal}}}'
].join('\n');

// Run a control-plane `workflows`/`workflow` command against isolated roots.
// `opts.workflowRoots` is an array of configured example roots appended via
// repeated `--workflow-root`. The default `examples` configured root is always
// present in the CLI default, but tests pass an explicit empty temp examples
// directory via `--workflow-root <empty>` to avoid picking up the repo's real
// examples/, and rely on `--workspace-root` pointing at a temp dir (so the
// default `examples` resolves to <temp>/examples which won't exist).
const cp = (args) => JSON.parse(
  execFileSync('./bin/tesseraft', ['control-plane', ...args], { encoding: 'utf8' })
);

// Assert a single named workflow is the visible winner and inspect its shape.
const findWinner = (workflows, name, source) => {
  const matches = workflows.filter((w) => w.name === name);
  assert.equal(matches.length, 1, `expected exactly one visible "${name}", got ${matches.length}`);
  if (source !== undefined) assert.equal(matches[0].source, source);
  return matches[0];
};

// Each test uses a fresh temp directory tree to avoid cross-test state.
const makeRoots = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-scope-'));
  return {
    base,
    workspaceRoot: path.join(base, 'ws'),
    tesseraftHome: path.join(base, 'home'),
    examples: path.join(base, 'examples'),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true })
  };
};

const writeWorkflow = (dir, name, title) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.edn'), workflowEdn(name, title));
};

const baseArgs = (r) => [
  '--workspace-root', r.workspaceRoot,
  '--tesseraft-home', r.tesseraftHome,
  // Provide our temp examples dir explicitly as the configured root so the
  // repo's real `examples/` is never consulted even though it's the CLI
  // default; <workspaceRoot>/examples won't exist either.
  '--workflow-root', r.examples
];

test('example/global/project ordering: project wins and its duplicates list global + example', (t) => {
  const r = makeRoots();
  t.after(r.cleanup);

  // Same workflow name at all three scopes.
  writeWorkflow(path.join(r.workspaceRoot, '.tesseraft', 'workflows', 'shared'), 'shared-demo', 'Project Shared');
  writeWorkflow(path.join(r.tesseraftHome, 'workflows', 'shared'), 'shared-demo', 'Global Shared');
  writeWorkflow(path.join(r.examples, 'shared'), 'shared-demo', 'Example Shared');

  const { workflows } = cp([...baseArgs(r), 'workflows']);

  // Exactly one visible entry (precedence semantics unchanged): the project
  // (precedence 200) winner.
  const winner = findWinner(workflows, 'shared-demo', 'project');
  assert.equal(winner.precedence, 200);
  assert.ok(Array.isArray(winner.duplicates) && winner.duplicates.length === 2,
    `expected 2 duplicates (global+example), got ${JSON.stringify(winner.duplicates)}`);

  const dupScopes = winner.duplicates.map((d) => d.scope).sort();
  assert.deepEqual(dupScopes, ['configured', 'global']);
  const dupByScope = Object.fromEntries(winner.duplicates.map((d) => [d.scope, d]));
  assert.equal(dupByScope.global.precedence, 100);
  assert.equal(dupByScope.configured.precedence, 1);
  // Example/configured duplicates are strictly lower precedence than the winner.
  for (const d of winner.duplicates) assert.ok(d.precedence < winner.precedence);
  // No equal-precedence same-name conflicts here.
  assert.ok(!winner.conflicts || winner.conflicts.length === 0);

  // Regression guard: only one workflow name is visible (the winner set is
  // unchanged by the metadata addition).
  const names = workflows.map((w) => w.name).sort();
  assert.deepEqual(names, ['shared-demo']);
});

test('project override visibility: removing project lets global win and shadow the example', (t) => {
  const r = makeRoots();
  t.after(r.cleanup);

  writeWorkflow(path.join(r.tesseraftHome, 'workflows', 'shared'), 'shared-demo', 'Global Shared');
  writeWorkflow(path.join(r.examples, 'shared'), 'shared-demo', 'Example Shared');

  // No project workflow present -> global (precedence 100) wins.
  const { workflows } = cp([...baseArgs(r), 'workflows']);
  const winner = findWinner(workflows, 'shared-demo', 'global');
  assert.equal(winner.precedence, 100);
  assert.ok(Array.isArray(winner.duplicates) && winner.duplicates.length === 1);
  assert.equal(winner.duplicates[0].scope, 'configured');
  assert.equal(winner.duplicates[0].precedence, 1);
  assert.ok(!winner.conflicts || winner.conflicts.length === 0);

  // The detail endpoint mirrors the metadata (precedence + duplicates).
  const detail = cp([...baseArgs(r), 'workflow', 'shared-demo']);
  assert.equal(detail.workflow.source, 'global');
  assert.equal(detail.workflow.precedence, 100);
  assert.ok(Array.isArray(detail.workflow.duplicates) && detail.workflow.duplicates.length === 1);
  assert.equal(detail.workflow.duplicates[0].scope, 'configured');
});

test('same-name conflict at equal precedence is surfaced via conflicts and resolve still 409s', (t) => {
  const r = makeRoots();
  t.after(r.cleanup);

  // Two workflow.edn files with the SAME workflow name under the SAME
  // configured root (two subdirs). Both have precedence idx 1 (the single
  // --workflow-root), so they tie at equal precedence — the ambiguous case
  // resolve-workflow 409s on. The list endpoint should surface this via
  // `conflicts` on the visible entries (select-visible-workflow-entries keeps
  // ALL max-precedence entries for a name, so both stay visible).
  writeWorkflow(path.join(r.examples, 'a', 'dup'), 'conflict-demo', 'A Dup');
  writeWorkflow(path.join(r.examples, 'b', 'dup'), 'conflict-demo', 'B Dup');

  const { workflows } = cp([...baseArgs(r), 'workflows']);
  const conflicts = workflows.filter((w) => w.name === 'conflict-demo');
  // select-visible keeps both equal-precedence entries visible (unchanged
  // semantics); each should list the other in its `conflicts`.
  assert.equal(conflicts.length, 2, `expected both equal-precedence entries visible, got ${conflicts.length}`);
  assert.equal(conflicts.length, 2);
  const a = conflicts.find((w) => w.path.includes(`${path.sep}a${path.sep}`));
  const b = conflicts.find((w) => w.path.includes(`${path.sep}b${path.sep}`));
  assert.ok(a && b, 'expected both conflicting entries visible');
  assert.equal(a.precedence, b.precedence);
  assert.ok(Array.isArray(a.conflicts) && a.conflicts.length === 1, `a.conflicts=${JSON.stringify(a.conflicts)}`);
  assert.ok(Array.isArray(b.conflicts) && b.conflicts.length === 1, `b.conflicts=${JSON.stringify(b.conflicts)}`);
  // Each entry's conflict points to the OTHER entry's path.
  assert.ok(a.conflicts[0].path.includes(`${path.sep}b${path.sep}`));
  assert.ok(b.conflicts[0].path.includes(`${path.sep}a${path.sep}`));
  // Equal precedence => not duplicates.
  assert.ok(!a.duplicates || a.duplicates.length === 0);
  assert.ok(!b.duplicates || b.duplicates.length === 0);

  // Precedence semantics unchanged: resolve still 409s on the conflict.
  let errStatus = 0;
  let errBody;
  try {
    execFileSync('./bin/tesseraft',
      ['control-plane', ...baseArgs(r), 'workflow', 'conflict-demo'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    errStatus = error.status ?? 0;
    errBody = JSON.parse(error.stdout);
  }
  assert.ok(errStatus !== 0, 'expected resolve to exit nonzero on conflict');
  assert.equal(errBody.error.code, 'conflict');
  assert.equal(errBody.status, 409);
});

test('precedence semantics regression: visible name set is identical with and without metadata', (t) => {
  // The metadata is purely additive; the set of visible workflow names must
  // not change. We assert the visible names for a multi-scope fixture match
  // the expected single-winner-per-name contract regardless of the new fields.
  const r = makeRoots();
  t.after(r.cleanup);

  writeWorkflow(path.join(r.workspaceRoot, '.tesseraft', 'workflows', 'p'), 'proj-only', 'Proj');
  writeWorkflow(path.join(r.tesseraftHome, 'workflows', 'g'), 'global-only', 'Global');
  writeWorkflow(path.join(r.examples, 'e'), 'example-only', 'Ex');
  // A name present everywhere — project should win.
  writeWorkflow(path.join(r.workspaceRoot, '.tesseraft', 'workflows', 's'), 'shared', 'ProjS');
  writeWorkflow(path.join(r.tesseraftHome, 'workflows', 's'), 'shared', 'GlobalS');
  writeWorkflow(path.join(r.examples, 's'), 'shared', 'ExS');

  const { workflows } = cp([...baseArgs(r), 'workflows']);
  const names = workflows.map((w) => w.name).sort();
  assert.deepEqual(names, ['global-only', 'proj-only', 'shared', 'example-only'].sort());

  // Winners have the expected sources (precedence selection unchanged).
  const byName = Object.fromEntries(workflows.map((w) => [w.name, w]));
  assert.equal(byName['proj-only'].source, 'project');
  assert.equal(byName['global-only'].source, 'global');
  assert.equal(byName['example-only'].source, 'configured');
  assert.equal(byName['shared'].source, 'project');
  // Every visible entry has a precedence field (the new metadata is present).
  for (const w of workflows) assert.equal(typeof w.precedence, 'number');
});

test('malformed workflow entries still carry scope/precedence and do not break metadata', (t) => {
  const r = makeRoots();
  t.after(r.cleanup);

  // A malformed workflow.edn (not valid EDN) at the project scope.
  fs.mkdirSync(path.join(r.workspaceRoot, '.tesseraft', 'workflows', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(r.workspaceRoot, '.tesseraft', 'workflows', 'broken', 'workflow.edn'), '(not valid edn ((((');
  // A valid project workflow wins normally.
  writeWorkflow(path.join(r.workspaceRoot, '.tesseraft', 'workflows', 'ok'), 'ok-demo', 'OK');

  const { workflows } = cp([...baseArgs(r), 'workflows']);
  const broken = workflows.find((w) => w.path.includes(`${path.sep}broken${path.sep}`));
  const ok = workflows.find((w) => w.name === 'ok-demo');
  assert.ok(broken, 'expected broken entry to be present (not crash)');
  assert.equal(broken.source, 'project');
  assert.equal(typeof broken.precedence, 'number');
  assert.equal(broken.error.code, 'parse_error');
  assert.ok(ok, 'expected valid ok-demo to be present');
  assert.equal(ok.source, 'project');
});