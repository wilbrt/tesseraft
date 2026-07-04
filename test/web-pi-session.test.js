import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSettingsModel,
  createSessionWithModel,
  PiSettingsResolutionError
} from '../web/dist-server/lib/piSessionAdapter.js';

// Build a minimal mock SDK exposing ModelRegistry/AuthStorage constructors
// with the same `create()` shape used by the real adapter.
const mockSdk = ({ findReturn, findThrows, constructThrows } = {}) => {
  const calls = { find: [] };
  const registry = {
    find: (provider, modelId) => {
      calls.find.push({ provider, modelId });
      if (findThrows) throw new Error(findThrows === true ? 'find boom' : findThrows);
      return findReturn;
    }
  };
  const AuthStorage = function AuthStorage() {};
  AuthStorage.create = () => {
    if (constructThrows) throw new Error(constructThrows === true ? 'construct boom' : constructThrows);
    return { auth: true };
  };
  const ModelRegistry = function ModelRegistry() {};
  ModelRegistry.create = () => registry;
  return { sdk: { AuthStorage, ModelRegistry }, registry, calls };
};

test('resolveSettingsModel: unconfigured (no provider/model) returns undefined and does not touch the SDK', async () => {
  const { sdk } = mockSdk({ findReturn: { id: 'model' } });
  const resolved = await resolveSettingsModel(sdk, {});
  assert.equal(resolved, undefined);
  const resolvedProviderOnly = await resolveSettingsModel(sdk, { provider: 'anthropic' });
  assert.equal(resolvedProviderOnly, undefined);
  const resolvedModelOnly = await resolveSettingsModel(sdk, { model: 'claude-3-5-sonnet' });
  assert.equal(resolvedModelOnly, undefined);
});

test('resolveSettingsModel: configured + resolvable returns {model, authStorage, modelRegistry}', async () => {
  const { sdk, registry } = mockSdk({ findReturn: { id: 'resolved-model' } });
  const resolved = await resolveSettingsModel(sdk, { provider: 'anthropic', model: 'claude-3-5-sonnet' });
  assert.ok(resolved, 'expected a resolved model');
  assert.deepEqual(resolved.model, { id: 'resolved-model' });
  assert.deepEqual(resolved.authStorage, { auth: true });
  assert.equal(resolved.modelRegistry, registry);
});

test('resolveSettingsModel: catalog miss (find returns undefined) throws PiSettingsResolutionError', async () => {
  const { sdk } = mockSdk({ findReturn: undefined });
  await assert.rejects(
    () => resolveSettingsModel(sdk, { provider: 'foo', model: 'bar' }),
    (error) => {
      assert.ok(error instanceof PiSettingsResolutionError, 'typed error');
      assert.equal(error.name, 'PiSettingsResolutionError');
      assert.equal(error.status, 400);
      assert.equal(error.code, 'pi_settings_resolution');
      assert.match(error.message, /foo/);
      assert.match(error.message, /bar/);
      assert.match(error.message, /no catalog entry/);
      return true;
    }
  );
});

test('resolveSettingsModel: missing ModelRegistry.create throws typed error', async () => {
  const sdk = { AuthStorage: function () {} };
  sdk.AuthStorage.create = () => ({});
  // ModelRegistry without a create() static
  const MR = function () {};
  sdk.ModelRegistry = MR;
  await assert.rejects(
    () => resolveSettingsModel(sdk, { provider: 'foo', model: 'bar' }),
    (error) => {
      assert.ok(error instanceof PiSettingsResolutionError);
      assert.match(error.message, /ModelRegistry is unavailable/);
      return true;
    }
  );
});

test('resolveSettingsModel: missing AuthStorage.create throws typed error', async () => {
  const sdk = {};
  const AS = function () {};
  sdk.AuthStorage = AS; // no create()
  const MR = function () {};
  MR.create = () => ({ find: () => undefined });
  sdk.ModelRegistry = MR;
  await assert.rejects(
    () => resolveSettingsModel(sdk, { provider: 'foo', model: 'bar' }),
    (error) => {
      assert.match(error.message, /AuthStorage is unavailable/);
      return true;
    }
  );
});

test('resolveSettingsModel: construction throw is wrapped in typed error', async () => {
  const { sdk } = mockSdk({ constructThrows: 'no auth path' });
  await assert.rejects(
    () => resolveSettingsModel(sdk, { provider: 'p', model: 'm' }),
    (error) => {
      assert.ok(error instanceof PiSettingsResolutionError);
      assert.match(error.message, /registry construction failed: no auth path/);
      return true;
    }
  );
});

test('resolveSettingsModel: find() throw is wrapped in typed error', async () => {
  const { sdk } = mockSdk({ findThrows: 'catalog corruption' });
  await assert.rejects(
    () => resolveSettingsModel(sdk, { provider: 'p', model: 'm' }),
    (error) => {
      assert.ok(error instanceof PiSettingsResolutionError);
      assert.match(error.message, /catalog lookup failed: catalog corruption/);
      return true;
    }
  );
});

test('createSessionWithModel: unconfigured omits model/authStorage/modelRegistry', async () => {
  const calls = [];
  const result = await createSessionWithModel(
    async (options) => { calls.push(options); return { ok: true }; },
    { sessionManager: 'sm' },
    undefined
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ sessionManager: 'sm' }]);
  assert.equal('model' in calls[0], false, 'model must be omitted when unconfigured');
});

test('createSessionWithModel: configured passes model/authStorage/modelRegistry', async () => {
  const calls = [];
  const resolved = { model: { id: 'm' }, authStorage: { auth: true }, modelRegistry: { find: () => undefined } };
  await createSessionWithModel(
    async (options) => { calls.push(options); return { ok: true }; },
    { sessionManager: 'sm' },
    resolved
  );
  assert.equal(calls[0].model, resolved.model);
  assert.equal(calls[0].authStorage, resolved.authStorage);
  assert.equal(calls[0].modelRegistry, resolved.modelRegistry);
  assert.equal(calls[0].sessionManager, 'sm');
});

test('createSessionWithModel: does NOT retry on createAgentSession throw (errors propagate)', async () => {
  let callCount = 0;
  await assert.rejects(
    () => createSessionWithModel(
      async () => { callCount += 1; throw new Error('create boom'); },
      { sessionManager: 'sm' },
      { model: { id: 'm' }, authStorage: {}, modelRegistry: {} }
    ),
    (error) => {
      assert.match(error.message, /create boom/);
      return true;
    }
  );
  assert.equal(callCount, 1, 'createAgentSession must be called exactly once (no blind retry)');
});

test('createSessionWithModel: resolves before calling createAgentSession so resolution errors never reach the SDK call', async () => {
  // The caller (createSession) awaits resolveSettingsModel first; if it throws,
  // createSessionWithModel is never invoked. Simulate that contract here.
  let sdkCalled = false;
  const resolveFirst = async () => {
    try {
      await resolveSettingsModel(
        { AuthStorage: function () {}, ModelRegistry: function () {} },
        { provider: 'foo', model: 'bar' }
      );
      // would have called the SDK here:
      await createSessionWithModel(async () => { sdkCalled = true; return {}; }, {}, undefined);
    } catch (_) {
      // expected
    }
  };
  await resolveFirst();
  assert.equal(sdkCalled, false, 'SDK must not be invoked when resolution throws');
});