/* global fetch */
'use strict';

const workflowList = document.getElementById('workflow-list');
const workflowDetail = document.getElementById('workflow-detail');
const workflowError = document.getElementById('workflow-error');
const graphNodes = document.getElementById('graph-nodes');
const graphEdges = document.getElementById('graph-edges');
const runList = document.getElementById('run-list');
const runDetail = document.getElementById('run-detail');
const runError = document.getElementById('run-error');
const runEvents = document.getElementById('run-events');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function showError(element, error) {
  element.hidden = false;
  element.textContent = error && error.message ? error.message : String(error);
}

function clearError(element) {
  element.hidden = true;
  element.textContent = '';
}

async function getJson(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error && data.error.message ? data.error.message : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function renderList(element, items, emptyText) {
  if (!items.length) {
    element.innerHTML = `<li class="muted">${escapeHtml(emptyText)}</li>`;
    return;
  }
  element.innerHTML = items.join('');
}

async function selectWorkflow(name) {
  clearError(workflowError);
  workflowDetail.className = 'loading';
  workflowDetail.textContent = 'Loading workflow...';
  graphNodes.innerHTML = '';
  graphEdges.innerHTML = '';
  try {
    const [detail, graph] = await Promise.all([
      getJson(`/api/workflows/${encodeURIComponent(name)}`),
      getJson(`/api/workflows/${encodeURIComponent(name)}/graph`)
    ]);
    const workflow = detail.workflow;
    workflowDetail.className = '';
    workflowDetail.innerHTML = `
      <dl>
        <dt>Name</dt><dd>${escapeHtml(workflow.name)}</dd>
        <dt>Path</dt><dd>${escapeHtml(workflow.path)}</dd>
        <dt>API version</dt><dd>${escapeHtml(workflow.api_version)}</dd>
        <dt>Lint</dt><dd>${escapeHtml(workflow.lint && workflow.lint.ok ? 'ok' : 'has issues')}</dd>
      </dl>`;
    renderList(graphNodes, (graph.nodes || []).map((node) => (
      `<li><strong>${escapeHtml(node.id)}</strong> <span>${escapeHtml(node.type)}</span>${node.title ? ` — ${escapeHtml(node.title)}` : ''}</li>`
    )), 'No graph nodes found.');
    renderList(graphEdges, (graph.edges || []).map((edge) => (
      `<li><strong>${escapeHtml(edge.from)}</strong> → <strong>${escapeHtml(edge.to)}</strong>${edge.condition ? ` <span>when ${escapeHtml(edge.condition)}</span>` : ''}</li>`
    )), 'No graph edges found.');
  } catch (error) {
    showError(workflowError, error);
    workflowDetail.className = 'empty';
    workflowDetail.textContent = 'Could not load workflow.';
  }
}

async function selectRun(runId) {
  clearError(runError);
  runDetail.className = 'loading';
  runDetail.textContent = 'Loading run...';
  runEvents.innerHTML = '';
  try {
    const [detail, events] = await Promise.all([
      getJson(`/api/runs/${encodeURIComponent(runId)}`),
      getJson(`/api/runs/${encodeURIComponent(runId)}/events`)
    ]);
    const run = detail.run;
    runDetail.className = '';
    runDetail.innerHTML = `
      <dl>
        <dt>Run ID</dt><dd>${escapeHtml(run.run_id)}</dd>
        <dt>Workflow</dt><dd>${escapeHtml(run.workflow_name)}</dd>
        <dt>Status</dt><dd>${escapeHtml(run.status)}</dd>
        <dt>State</dt><dd>${escapeHtml(run.state)}</dd>
        <dt>Round / attempt</dt><dd>${escapeHtml(run.round)} / ${escapeHtml(run.attempt)}</dd>
        <dt>Path</dt><dd>${escapeHtml(run.path)}</dd>
      </dl>`;
    renderList(runEvents, (events.events || []).map((event) => (
      `<li><code>${escapeHtml(event.event || event.type || 'event')}</code><pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre></li>`
    )), 'No events found.');
  } catch (error) {
    showError(runError, error);
    runDetail.className = 'empty';
    runDetail.textContent = 'Could not load run.';
  }
}

async function loadWorkflows() {
  clearError(workflowError);
  try {
    const data = await getJson('/api/workflows');
    const workflows = data.workflows || [];
    renderList(workflowList, workflows.map((workflow) => (
      `<li><button type="button" data-workflow="${escapeHtml(workflow.name)}">${escapeHtml(workflow.name || '(unnamed)')}</button><span>${escapeHtml(workflow.path)}</span></li>`
    )), 'No workflows found.');
  } catch (error) {
    showError(workflowError, error);
  }
}

async function loadRuns() {
  clearError(runError);
  try {
    const data = await getJson('/api/runs');
    const runs = data.runs || [];
    renderList(runList, runs.map((run) => (
      `<li><button type="button" data-run="${escapeHtml(run.run_id)}">${escapeHtml(run.run_id)}</button><span>${escapeHtml(run.workflow_name)} — ${escapeHtml(run.status)}</span></li>`
    )), 'No runs found. Run a workflow locally to populate this list.');
  } catch (error) {
    showError(runError, error);
  }
}

workflowList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-workflow]');
  if (button) selectWorkflow(button.dataset.workflow);
});

runList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-run]');
  if (button) selectRun(button.dataset.run);
});

loadWorkflows();
loadRuns();
