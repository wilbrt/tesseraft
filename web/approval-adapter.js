#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 64 * 1024;
const adapterExitDelayMs = Math.min(30_000, Math.max(0, Number(process.env.TESSERAFT_TEST_ADAPTER_EXIT_DELAY_MS) || 2000));
const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, index, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[index + 1]]);
  return all;
}, []));
const required = ['run-dir', 'state', 'attempt', 'approval-id'];
for (const key of required) if (!args[key]) throw new Error(`Missing --${key}`);
const runDir = path.resolve(args['run-dir']);
const state = args.state;
const attempt = Number(args.attempt);
const approvalId = args['approval-id'];
const adapterDir = path.join(runDir, 'approval-adapters', state, String(attempt));
const ownerPath = path.join(adapterDir, 'owner.json');
const capabilityPath = path.join(adapterDir, 'capability.json');
const requestPath = path.join(runDir, 'approvals', `${approvalId}.json`);
let accepting = true;
let draining = false;
let sockets = new Set();

const atomicJson = async (target, value, mode) => {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (mode) await chmod(temporary, mode);
  await rename(temporary, target);
};
const readJson = async (target) => JSON.parse(await readFile(target, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const safeToken = (provided, expected) => {
  const actual = Buffer.from(sha256(provided || ''), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};
const json = (res, status, body) => {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
  res.end(encoded);
};
const tokenFrom = (req, url) => req.headers['x-tesseraft-approval-token'] || url.searchParams.get('token') || '';
const hostSafe = (req) => /^127\.0\.0\.1:\d+$/.test(req.headers.host || '');
const originSafe = (req) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
const html = (token) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Git change approval</title><style>
:root{color-scheme:dark;font:14px system-ui;background:#101318;color:#e9edf3}body{margin:0}main{max-width:1200px;margin:auto;padding:20px}.bar,.actions{display:flex;gap:12px;align-items:center}.bar{justify-content:space-between}pre{background:#080a0d;border:1px solid #303846;border-radius:8px;overflow:auto;padding:8px}.line{display:block;min-height:20px;white-space:pre}.line:hover{background:#222b38}.line.add{background:#123322}.line.del{background:#3c1b20}.n{display:inline-block;width:55px;color:#8290a5;text-align:right;margin-right:12px;user-select:none}textarea{width:100%;box-sizing:border-box;background:#171c24;color:inherit;border:1px solid #445065;border-radius:6px;padding:10px}button{padding:9px 16px;border:0;border-radius:6px;font-weight:650;cursor:pointer}.pass{background:#2ca56a}.reject{background:#d7545d}.annotation{margin:4px 0 8px 68px}.muted{color:#9aa7b8}.hidden{display:none}</style></head><body><main><div class="bar"><div><h1>Review current Git changes</h1><p id="question" class="muted"></p></div><code>${state}/${attempt}</code></div><pre id="diff">Loading…</pre><section id="composer" class="hidden"><p>Annotation for line <span id="selected"></span></p><textarea id="annotation" maxlength="20000" rows="3" placeholder="Explain what should change at this line…"></textarea><button id="add">Add annotation</button></section><h2>Overall message</h2><textarea id="message" maxlength="100000" rows="5"></textarea><p id="count" class="muted">0 annotations</p><div class="actions"><button class="pass" data-decision="pass">Pass</button><button class="reject" data-decision="reject">Reject</button><span id="status"></span></div></main><script>
const token=${JSON.stringify(token)};let review,selected=null,annotations=[];const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
fetch('/api/review',{headers:{'x-tesseraft-approval-token':token}}).then(r=>r.json()).then(x=>{review=x;question.textContent=x.request.question||x.request.message||'';diff.innerHTML=x.diff.split('\\n').map((line,i)=>'<span class="line '+(line.startsWith('+')&&!line.startsWith('+++')?'add':line.startsWith('-')&&!line.startsWith('---')?'del':'')+'" data-line="'+(i+1)+'"><span class="n">'+(i+1)+'</span>'+esc(line)+'</span>').join('');});
diff.onclick=e=>{const row=e.target.closest('.line');if(!row)return;selected=Number(row.dataset.line);composer.classList.remove('hidden');document.querySelector('#selected').textContent=selected;annotation.focus();};
add.onclick=()=>{const body=annotation.value.trim();const anchor=review.anchors[String(selected)];if(!body||!anchor)return;annotations.push({id:'a-'+Date.now(),artifact_path:review.request.review_server.evidence_path,body,anchor});annotation.value='';composer.classList.add('hidden');count.textContent=annotations.length+' annotation'+(annotations.length===1?'':'s');};
document.querySelectorAll('[data-decision]').forEach(button=>button.onclick=async()=>{const decision=button.dataset.decision;const body={decision,message:message.value.trim(),annotations};if(decision==='reject'&&!body.message){status.textContent='Reject requires an overall message.';return;}document.querySelectorAll('button').forEach(x=>x.disabled=true);status.textContent='Recording…';const response=await fetch('/api/decision',{method:'POST',headers:{'content-type':'application/json','x-tesseraft-approval-token':token},body:JSON.stringify(body)});const result=await response.json();status.textContent=response.ok?'Decision recorded. This review endpoint is closing.':(result.error?.message||'Decision failed');if(!response.ok)document.querySelectorAll('button').forEach(x=>x.disabled=false);});
</script></body></html>`;

const token = await new Promise((resolve, reject) => {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { body += chunk; if (body.length > 256) reject(new Error('Invalid capability')); });
  process.stdin.on('end', () => resolve(body));
  process.stdin.on('error', reject);
});
if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new Error('Invalid capability');
const initialOwner = await readJson(ownerPath);
if (initialOwner.pid !== process.pid || initialOwner.approval_id !== approvalId || initialOwner.capability_hash !== sha256(token)) {
  throw new Error(`Owner claim mismatch (pid=${initialOwner.pid === process.pid}, approval=${initialOwner.approval_id === approvalId}, capability_hash=${initialOwner.capability_hash === sha256(token)})`);
}
let ownerUpdate = Promise.resolve(initialOwner);
const updateOwner = (patch) => {
  ownerUpdate = ownerUpdate.then(async (current) => {
    const next = { ...current, ...patch };
    await atomicJson(ownerPath, next);
    return next;
  });
  return ownerUpdate;
};
const request = await readJson(requestPath);
const review = request.review_server;
if (!review || request.state !== state || request.attempt !== attempt || request.approval_id !== approvalId) throw new Error('Approval tuple mismatch');
const evidencePath = path.resolve(runDir, review.evidence_path);
if (!evidencePath.startsWith(`${runDir}${path.sep}`)) throw new Error('Evidence path escaped run directory');
const diff = await readFile(evidencePath, 'utf8');
if (sha256(diff) !== review.evidence_sha256 || Buffer.byteLength(diff) !== review.evidence_size) throw new Error('Evidence integrity mismatch');

const installRoot = process.env.TESSERAFT_INSTALL_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tesseraftBin = path.join(installRoot, 'bin', 'tesseraft');
const decision = (payload) => new Promise((resolve) => {
  execFile(tesseraftBin, ['run', 'apply', '--input', '-'], { cwd: installRoot, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    try { resolve({ error, result: JSON.parse(stdout || '{}'), stderr }); }
    catch { resolve({ error: error || new Error('Runtime returned invalid JSON'), result: null, stderr }); }
  }).stdin.end(JSON.stringify({ operation: 'run.decide', payload: { run_dir: runDir, approval_id: approvalId, ...payload } }));
});
let supervisorsStarted = false;
const startSupervisors = (submissionId, transportStatus) => {
  if (supervisorsStarted) return [];
  supervisorsStarted = true;
  return [0, 1].map((candidateIndex) => {
    const child = spawn(tesseraftBin, ['run', 'apply', '--input', '-'], {
      cwd: installRoot, detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, AGENT_RUN_DIR: runDir }
    });
    child.once('error', (error) => {
      void updateOwner({ supervisor_status: 'candidate-launch-failed',
                         supervisor_candidate: candidateIndex, supervisor_error: error.message });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ operation: 'approval.adapter.supervise', payload: {
      run_dir: runDir, state, attempt, approval_id: approvalId,
      pid: initialOwner.pid, process_started_at: initialOwner.process_started_at,
      submission_id: submissionId, transport_status: transportStatus
    } }));
    child.unref();
    return child.pid;
  });
};
const drain = async (reason) => {
  if (draining) return;
  draining = true; accepting = false;
  server.close(async () => {
    await rm(capabilityPath, { force: true });
    await updateOwner({ status: 'listener-closed', lifecycle_status: 'listener-closed',
                        stop_reason: reason, listener_closed_at: new Date().toISOString() });
    // Listener closure and exact process absence are separate lifecycle gates.
    // Keep a short bounded grace so the detached supervisor, rather than this
    // adapter, remains responsible if the adapter is killed at this boundary.
    if (process.env.TESSERAFT_TEST_ADAPTER_HOLD_AFTER_ABORT === 'true' && reason.startsWith('transport-aborted')) {
      setInterval(() => {}, 60_000);
    } else {
      setTimeout(() => process.exit(0), adapterExitDelayMs).unref();
    }
  });
  setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1500).unref();
};
const server = createServer(async (req, res) => {
  try {
    if (!hostSafe(req) || !originSafe(req) || req.headers['x-forwarded-for']) return json(res, 403, { error: { code: 'forbidden', message: 'Loopback origin required' } });
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (!safeToken(tokenFrom(req, url), initialOwner.capability_hash)) return json(res, 401, { error: { code: 'unauthorized', message: 'Invalid approval capability' } });
    if (!accepting) return json(res, 410, { error: { code: 'gone', message: 'Approval endpoint is draining' } });
    if (req.method === 'GET' && url.pathname === '/') { const page = html(token); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' }); return res.end(page); }
    if (req.method === 'GET' && url.pathname === '/api/review') return json(res, 200, { request, diff, anchors: review.anchors });
    if (req.method === 'POST' && url.pathname === '/api/decision') {
      const submissionId = randomUUID();
      let transportStatus = 'pending';
      const abortTransport = (phase) => {
        if (transportStatus !== 'pending') return;
        transportStatus = 'aborted'; accepting = false;
        const supervisorPids = startSupervisors(submissionId, 'aborted');
        void updateOwner({ status: 'draining', submission_id: submissionId, transport_status: 'aborted',
                           transport_aborted_at: new Date().toISOString(), abort_phase: phase,
                           supervisor_pid: supervisorPids[0], supervisor_candidate_pids: supervisorPids })
          .finally(() => drain('transport-aborted'));
      };
      req.once('aborted', () => abortTransport('request-aborted'));
      req.socket?.once('error', () => abortTransport('socket-error'));
      res.once('close', () => { if (!res.writableFinished) abortTransport('response-close'); });
      let body = ''; let oversized = false;
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > MAX_BODY) { oversized = true; break; } }
      if (oversized) return json(res, 413, { error: { code: 'payload_too_large', message: 'Decision payload exceeds 64 KiB' } });
      let payload; try { payload = JSON.parse(body); } catch { return json(res, 400, { error: { code: 'bad_request', message: 'Malformed JSON' } }); }
      accepting = false;
      await updateOwner({ submission_id: submissionId, transport_status: 'pending', decision_started_at: new Date().toISOString() });
      const outcome = await decision(payload);
      if (outcome.error || outcome.result?.error) {
        if (transportStatus === 'aborted') { void drain('transport-aborted-uncommitted'); return; }
        accepting = true;
        const failure = outcome.result || { error: { code: 'runtime_error', message: outcome.stderr || outcome.error?.message } };
        return json(res, failure.status || 422, failure);
      }
      if (transportStatus === 'aborted') { void drain('transport-aborted'); return; }
      res.once('finish', () => {
        if (transportStatus !== 'pending') return;
        transportStatus = 'finished';
        const supervisorPids = startSupervisors(submissionId, 'finished');
        void updateOwner({ status: 'draining', submission_id: submissionId, transport_status: 'finished',
                           response_finished_at: new Date().toISOString(), supervisor_pid: supervisorPids[0],
                           supervisor_candidate_pids: supervisorPids })
          .then(() => drain('decision'));
      });
      json(res, 200, outcome.result);
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  } catch (error) { json(res, 500, { error: { code: 'adapter_error', message: error instanceof Error ? error.message : String(error) } }); }
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  await atomicJson(capabilityPath, { version: 1, token, launch_url: `${endpoint}/?token=${encodeURIComponent(token)}` }, 0o600);
  await chmod(capabilityPath, 0o600);
  await updateOwner({ status: 'ready', endpoint, ready_at: new Date().toISOString() });
});
const monitor = setInterval(async () => {
  try {
    const stateText = await readFile(path.join(runDir, 'state.edn'), 'utf8');
    const decisionExists = await stat(path.join(runDir, 'approvals', `${approvalId}-decision.json`)).then(() => true, () => false);
    if (decisionExists || !stateText.includes(':status "blocked"') || !stateText.includes(`:state :${state}`)) void drain(decisionExists ? 'decision-observed' : 'state-changed');
  } catch { void drain('inspection-failed'); }
}, 1000);
monitor.unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void drain(signal));
