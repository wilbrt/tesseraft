#!/usr/bin/env node
// Deterministic helper: materialize pr/fetched-pr.json from a PR number input.
//
// Process-node contract (Tesseraft :process):
//   stdin  -> JSON request: { "inputs": { "pr-number": "<N>" }, "paths": { "run_dir": "<dir>" } }
//   stdout -> JSON response: { "ok": true, "status": "ok", "outputs": { "pr-json": "pr/fetched-pr.json" } }
//
// Writes <run_dir>/pr/fetched-pr.json with at minimum { "number": <int>, ... } so that
// the downstream :github/fetch-pr-feedback handler (which reads
// (:number pr) from pr/fetched-pr.json) can fetch PR comments/reviews.
//
// Uses `gh pr view <N> --json ...` when available (provides full metadata);
// falls back to a minimal {"number": N} stub when gh is unavailable/offline so
// the workflow still lints and can be dry-run.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, status: "error", error: message }) + "\n");
  process.exit(1);
}

let request;
try {
  request = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
  fail("could not parse JSON request from stdin: " + e.message);
}

const runDir = request && request.paths && request.paths.run_dir;
if (!runDir) fail("request.paths.run_dir is required");

const prNumberRaw = request && request.inputs && request.inputs["pr-number"];
if (prNumberRaw === undefined || prNumberRaw === null || prNumberRaw === "") {
  fail("inputs.pr-number is required");
}

const prNumber = Number.parseInt(String(prNumberRaw), 10);
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  fail("inputs.pr-number must be a positive integer, got: " + JSON.stringify(prNumberRaw));
}

const prDir = path.join(runDir, "pr");
fs.mkdirSync(prDir, { recursive: true });

const prJsonPath = path.join(prDir, "fetched-pr.json");

let prMeta;
try {
  const out = execFileSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "number,url,title,body,state,headRefName,baseRefName"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  prMeta = JSON.parse(out);
  if (!Number.isInteger(prMeta.number)) {
    // gh returned something unexpected; force-correct the number field.
    prMeta.number = prNumber;
  }
} catch (e) {
  // gh unavailable, not authenticated, or offline: write a minimal stub so the
  // workflow can still be linted / dry-run. The downstream handler will surface
  // any real gh failure when it actually runs.
  prMeta = { number: prNumber, _source: "fetch_pr_meta.js stub", _error: String(e && e.message || e) };
}

fs.writeFileSync(prJsonPath, JSON.stringify(prMeta, null, 2) + "\n");

process.stdout.write(
  JSON.stringify({
    ok: true,
    status: "ok",
    outputs: { "pr-json": "pr/fetched-pr.json" }
  }) + "\n"
);