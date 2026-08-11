import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialStudioDocument,
  studioDocumentReducer,
  toGraphEdges
} from '../web/src/features/studio/model.ts';
import { emptyDraft } from '../web/src/types/studio.ts';

test('Studio reducer rewires node references when an id changes', () => {
  const draft = emptyDraft('reducer-test');
  draft.initial = 'start';
  draft.states = {
    start: { id: 'start', type: 'deterministic', handler: 'noop/succeed', next: 'done' },
    done: { id: 'done', type: 'terminal', status: 'success' }
  };
  const loaded = studioDocumentReducer(initialStudioDocument, {
    type: 'loaded', draft, positions: { start: { x: 10, y: 20 }, done: { x: 30, y: 40 } }
  });
  const edited = studioDocumentReducer(loaded, {
    type: 'edit-node',
    id: 'done',
    form: {
      id: 'complete', type: 'terminal', title: 'Complete', agentExecutor: '',
      agentPromptTemplate: '', agentPromptOutput: '', agentStatusPath: '',
      deterministicHandler: '', deterministicNext: '', processCommand: '',
      processInputMode: '', processOutputMode: '', processNext: '',
      timerDuration: '', timerNext: '', approvalMessage: '',
      terminalStatus: 'success', transitions: undefined
    }
  });

  assert.equal(edited.draft.states.start.next, 'complete');
  assert.equal(edited.draft.states.done, undefined);
  assert.deepEqual(edited.positions.complete, { x: 30, y: 40 });
  assert.equal(edited.dirty, true);
});

test('Studio reducer keeps graph transformations semantic and colon-free', () => {
  const draft = emptyDraft('graph-test');
  draft.states = {
    start: { id: 'start', type: 'router', transitions: [{ when: { status: 'ok' }, next: 'done' }] },
    done: { id: 'done', type: 'terminal', status: 'success' }
  };
  const edges = toGraphEdges(draft);
  assert.deepEqual(edges, [{ from: 'start', to: 'done', condition: { status: 'ok' } }]);
  const visit = (value) => {
    if (typeof value === 'string') assert.equal(value.startsWith(':'), false);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(draft);
});
