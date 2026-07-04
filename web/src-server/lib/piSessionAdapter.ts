export type PiSessionStatus = 'idle' | 'running' | 'done' | 'error';
export type PiSessionRole = 'system' | 'user' | 'assistant' | 'tool';

export type PiSessionEvent = {
  id: string;
  session_id: string;
  sequence: number;
  created_at: string;
  event: string;
  role?: PiSessionRole;
  text?: string;
  prompt?: string;
  data?: Record<string, unknown>;
};

export type PiChatMessage = {
  id: string;
  session_id: string;
  sequence: number;
  created_at: string;
  role: PiSessionRole;
  text: string;
  status?: PiSessionStatus;
};

export type PiSessionSummary = {
  id: string;
  title: string;
  status: PiSessionStatus;
  created_at: string;
  updated_at: string;
  event_count: number;
};

export type PiSessionDetail = PiSessionSummary & {
  events: PiSessionEvent[];
  messages: PiChatMessage[];
};

export type SendPromptResult = {
  session: PiSessionSummary;
  events: PiSessionEvent[];
  messages: PiChatMessage[];
};

export type CreatePiSessionInput = {
  id?: string;
  title?: string;
};

export type PiSessionAdapter = {
  listSessions: () => Promise<PiSessionSummary[]>;
  createSession: (input?: CreatePiSessionInput) => Promise<PiSessionDetail>;
  getSession: (sessionId: string) => Promise<PiSessionDetail | null>;
  sendPrompt: (sessionId: string, prompt: string) => Promise<SendPromptResult | null>;
  listEvents: (sessionId: string, after?: number) => Promise<PiSessionEvent[] | null>;
  listMessages: (sessionId: string, after?: number) => Promise<PiChatMessage[] | null>;
};

type StoredSession = PiSessionSummary & { events: PiSessionEvent[] };

const toIso = (): string => new Date().toISOString();
const validId = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);
const cloneEvent = (event: PiSessionEvent): PiSessionEvent => ({ ...event, data: event.data ? { ...event.data } : undefined });
const cloneMessage = (message: PiChatMessage): PiChatMessage => ({ ...message });

const sdkAssistantDelta = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const assistant = (value as Record<string, unknown>).assistantMessageEvent;
  if (!assistant || typeof assistant !== 'object') return undefined;
  const delta = (assistant as { delta?: unknown }).delta;
  return typeof delta === 'string' ? delta : undefined;
};

const isStoredSdkAssistantDelta = (event: PiSessionEvent): boolean => Boolean(sdkAssistantDelta(event.data?.sdk_event));

export const derivePiChatMessages = (events: PiSessionEvent[], after?: number): PiChatMessage[] => {
  const messages: PiChatMessage[] = [];
  for (const event of events) {
    const role = event.role || (isStoredSdkAssistantDelta(event) ? 'assistant' : event.event.startsWith('session.') ? 'system' : undefined);
    const text = event.text || event.prompt || '';
    if (!role || !text) continue;

    const last = messages[messages.length - 1];
    const assistantDelta = role === 'assistant' && event.event !== 'assistant.message';
    if (assistantDelta && last?.role === 'assistant') {
      last.text += text;
      last.created_at = event.created_at;
      continue;
    }

    messages.push({
      id: `msg-${event.id}`,
      session_id: event.session_id,
      sequence: event.sequence,
      created_at: event.created_at,
      role,
      text,
      status: event.event === 'session.error' ? 'error' : undefined
    });
  }
  return messages.filter((message) => after === undefined || message.sequence > after).map(cloneMessage);
};
const cloneSummary = (session: StoredSession): PiSessionSummary => ({
  id: session.id,
  title: session.title,
  status: session.status,
  created_at: session.created_at,
  updated_at: session.updated_at,
  event_count: session.events.length
});
const cloneDetail = (session: StoredSession): PiSessionDetail => ({ ...cloneSummary(session), events: session.events.map(cloneEvent), messages: derivePiChatMessages(session.events) });

export const createFakePiSessionAdapter = (): PiSessionAdapter => {
  const sessions = new Map<string, StoredSession>();
  let nextSession = 1;
  let nextEvent = 1;

  const appendEvent = (session: StoredSession, event: Omit<PiSessionEvent, 'id' | 'session_id' | 'sequence' | 'created_at'>): PiSessionEvent => {
    const createdAt = toIso();
    const piEvent: PiSessionEvent = {
      id: `evt-${nextEvent++}`,
      session_id: session.id,
      sequence: session.events.length + 1,
      created_at: createdAt,
      ...event
    };
    session.events.push(piEvent);
    session.updated_at = createdAt;
    session.event_count = session.events.length;
    return piEvent;
  };

  return {
    listSessions: async () => Array.from(sessions.values()).map(cloneSummary).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    createSession: async (input = {}) => {
      const id = input.id?.trim() || `pi-session-${nextSession++}`;
      if (!validId(id)) throw Object.assign(new Error('Session id may contain only letters, numbers, dot, underscore, and dash'), { status: 400, code: 'bad_request' });
      if (sessions.has(id)) throw Object.assign(new Error('Pi session id already exists'), { status: 409, code: 'conflict' });
      const createdAt = toIso();
      const session: StoredSession = {
        id,
        title: input.title?.trim() || id,
        status: 'idle',
        created_at: createdAt,
        updated_at: createdAt,
        event_count: 0,
        events: []
      };
      sessions.set(id, session);
      appendEvent(session, { event: 'session.created', role: 'system', text: 'Fake local Pi session created.' });
      return cloneDetail(session);
    },
    getSession: async (sessionId) => {
      const session = sessions.get(sessionId);
      return session ? cloneDetail(session) : null;
    },
    sendPrompt: async (sessionId, prompt) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      session.status = 'running';
      const userEvent = appendEvent(session, { event: 'prompt.sent', role: 'user', prompt, text: prompt });
      const assistantText = `Fake Pi adapter response to: ${prompt}`;
      const assistantEvent = appendEvent(session, { event: 'assistant.message', role: 'assistant', text: assistantText, data: { adapter: 'fake' } });
      session.status = 'done';
      session.updated_at = assistantEvent.created_at;
      return { session: cloneSummary(session), events: [cloneEvent(userEvent), cloneEvent(assistantEvent)], messages: derivePiChatMessages(session.events) };
    },
    listEvents: async (sessionId, after) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return session.events.filter((event) => after === undefined || event.sequence > after).map(cloneEvent);
    },
    listMessages: async (sessionId, after) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return derivePiChatMessages(session.events, after);
    }
  };
};

export const createRealPiSessionAdapter = (): PiSessionAdapter => {
  type SdkSession = { sessionId?: string; subscribe?: (listener: (event: unknown) => void) => (() => void); prompt?: (text: string) => Promise<void>; dispose?: () => void };
  type RealSession = StoredSession & { sdkSession: SdkSession; unsubscribe?: () => void };

  // Read default pi provider/model from the local settings file by shelling
  // out to the control-plane (mirrors /api/settings). Settings are local files
  // so this is cheap; reading per createSession keeps values fresh without a
  // cache-invalidation strategy in the adapter lifetime.
  const readPiDefaults = async (): Promise<{ provider?: string; model?: string }> => {
    try {
      const { runControlPlane } = await import('../lib/cli.js');
      const result = await runControlPlane(['settings', 'get'], { timeout: 5000 });
      if (result.status !== 200 || !result.body || typeof result.body !== 'object') return {};
      const settings = (result.body as { settings?: Record<string, unknown> }).settings;
      if (!settings) return {};
      const provider = typeof settings.pi_default_provider === 'string' && settings.pi_default_provider.trim() !== '' ? settings.pi_default_provider : undefined;
      const model = typeof settings.pi_default_model === 'string' && settings.pi_default_model.trim() !== '' ? settings.pi_default_model : undefined;
      return { provider, model };
    } catch {
      return {};
    }
  };

  // Resolve a stored `pi_default_provider`/`pi_default_model` pair into a
  // real `Model<any>` the Pi SDK actually understands. The SDK's
  // `createAgentSession` options accept `model?: Model<any>` (a constructed
  // Model object, NOT a string) and `modelRegistry?`/`authStorage?` for
  // discovery. Passing string-valued `provider`/`modelId` keys is silently
  // ignored (see CreateAgentSessionOptions in the installed
  // @earendil-works/pi-coding-agent/dist/core/sdk.d.ts), so we must resolve
  // the catalog Model ourselves via ModelRegistry.find(provider, modelId).
  // Both ModelRegistry and AuthStorage are re-exported by the same dynamic
  // `@earendil-works/pi-coding-agent` import used below; we do NOT import
  // `@earendil-works/pi-ai` directly because it is not hoisted into this
  // project's node_modules (it is only a transitive dep of pi-coding-agent).
  const resolveSettingsModel = async (sdk: Record<string, unknown>, defaults: { provider?: string; model?: string }): Promise<unknown | undefined> => {
    if (!defaults.provider || !defaults.model) return undefined;
    const ModelRegistryCtor = sdk.ModelRegistry as (new () => unknown) & { create?: (authStorage: unknown, modelsJsonPath?: string) => { find: (provider: string, modelId: string) => unknown | undefined } } | undefined;
    const AuthStorageCtor = sdk.AuthStorage as (new () => unknown) & { create?: (authPath?: string) => unknown } | undefined;
    if (!ModelRegistryCtor || typeof ModelRegistryCtor.create !== 'function') return undefined;
    if (!AuthStorageCtor || typeof AuthStorageCtor.create !== 'function') return undefined;
    try {
      const authStorage = AuthStorageCtor.create();
      const registry = ModelRegistryCtor.create(authStorage);
      const model = typeof registry.find === 'function' ? registry.find(defaults.provider, defaults.model) : undefined;
      return model;
    } catch {
      return undefined;
    }
  };

  const sessions = new Map<string, RealSession>();
  let nextSession = 1;
  let nextEvent = 1;

  const appendEvent = (session: RealSession, event: Omit<PiSessionEvent, 'id' | 'session_id' | 'sequence' | 'created_at'>): PiSessionEvent => {
    const createdAt = toIso();
    const piEvent: PiSessionEvent = {
      id: `real-evt-${nextEvent++}`,
      session_id: session.id,
      sequence: session.events.length + 1,
      created_at: createdAt,
      ...event
    };
    session.events.push(piEvent);
    session.updated_at = createdAt;
    session.event_count = session.events.length;
    return piEvent;
  };

  const loadSdk = async (): Promise<Record<string, unknown>> => {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;
    return dynamicImport('@earendil-works/pi-coding-agent').catch((error) => {
      throw Object.assign(new Error(`Real Pi adapter requested but @earendil-works/pi-coding-agent could not be loaded: ${error instanceof Error ? error.message : String(error)}`), { status: 503, code: 'pi_adapter_unavailable' });
    });
  };

  const sdkText = (event: unknown): string | undefined => {
    if (!event || typeof event !== 'object') return undefined;
    const record = event as Record<string, unknown>;
    const assistantDelta = sdkAssistantDelta(record);
    if (assistantDelta !== undefined) return assistantDelta;
    if ('message' in record && typeof record.message === 'string') return record.message;
    return undefined;
  };

  const sdkRole = (event: unknown): PiSessionRole | undefined => sdkAssistantDelta(event) !== undefined ? 'assistant' : undefined;

  return {
    listSessions: async () => Array.from(sessions.values()).map(cloneSummary).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    createSession: async (input = {}) => {
      const sdk = await loadSdk();
      const createAgentSession = sdk.createAgentSession;
      const sessionManagerFactory = sdk.SessionManager;
      if (typeof createAgentSession !== 'function' || !sessionManagerFactory || typeof (sessionManagerFactory as { inMemory?: unknown }).inMemory !== 'function') {
        throw Object.assign(new Error('Installed Pi SDK is incompatible: expected createAgentSession() and SessionManager.inMemory(). Update @earendil-works/pi-coding-agent or set TESSERAFT_PI_ADAPTER=fake for local fake responses.'), { status: 503, code: 'pi_adapter_unavailable' });
      }
      const sessionManager = (sessionManagerFactory as { inMemory: () => unknown }).inMemory();
      const defaults = await readPiDefaults();
      // Resolve the stored provider/model into a real `Model<any>` via the
      // SDK's ModelRegistry. createAgentSession only honors `options.model`
      // (a constructed Model object); string provider/modelId keys are
      // silently ignored, so resolution must happen here. If the configured
      // provider/model is not findable in the catalog (unknown provider, typo,
      // or no models.json entry), fall through to the SDK's own default model
      // discovery rather than blocking session creation.
      const resolvedModel = await resolveSettingsModel(sdk, defaults);
      const baseOptions: Record<string, unknown> = { sessionManager };
      const withDefaults: Record<string, unknown> = { ...baseOptions };
      if (resolvedModel !== undefined) withDefaults.model = resolvedModel;
      let result: { session: SdkSession };
      try {
        result = await (createAgentSession as (options: unknown) => Promise<{ session: SdkSession }>)(withDefaults);
      } catch (firstError) {
        try {
          result = await (createAgentSession as (options: unknown) => Promise<{ session: SdkSession }>)(baseOptions);
        } catch {
          throw firstError;
        }
      }
      const sdkSession = result.session;
      const id = input.id?.trim() || sdkSession.sessionId || `pi-session-${nextSession++}`;
      if (!validId(id)) throw Object.assign(new Error('Session id may contain only letters, numbers, dot, underscore, and dash'), { status: 400, code: 'bad_request' });
      if (sessions.has(id)) throw Object.assign(new Error('Pi session id already exists'), { status: 409, code: 'conflict' });
      const createdAt = toIso();
      const session: RealSession = {
        id,
        title: input.title?.trim() || id,
        status: 'idle',
        created_at: createdAt,
        updated_at: createdAt,
        event_count: 0,
        events: [],
        sdkSession
      };
      if (typeof sdkSession.subscribe === 'function') {
        session.unsubscribe = sdkSession.subscribe((event) => appendEvent(session, { event: typeof (event as { type?: unknown })?.type === 'string' ? (event as { type: string }).type : 'sdk.event', role: sdkRole(event), text: sdkText(event), data: { sdk_event: event as Record<string, unknown> } }));
      }
      sessions.set(id, session);
      appendEvent(session, { event: 'session.created', role: 'system', text: 'Real Pi SDK session created.' });
      return cloneDetail(session);
    },
    getSession: async (sessionId) => {
      const session = sessions.get(sessionId);
      return session ? cloneDetail(session) : null;
    },
    sendPrompt: async (sessionId, prompt) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (typeof session.sdkSession.prompt !== 'function') throw Object.assign(new Error('Pi SDK session does not expose prompt()'), { status: 503, code: 'pi_adapter_unavailable' });
      session.status = 'running';
      const before = session.events.length;
      appendEvent(session, { event: 'prompt.sent', role: 'user', prompt, text: prompt });
      try {
        await session.sdkSession.prompt(prompt);
        session.status = 'done';
      } catch (error) {
        session.status = 'error';
        appendEvent(session, { event: 'session.error', role: 'system', text: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return { session: cloneSummary(session), events: session.events.slice(before).map(cloneEvent), messages: derivePiChatMessages(session.events) };
    },
    listEvents: async (sessionId, after) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return session.events.filter((event) => after === undefined || event.sequence > after).map(cloneEvent);
    },
    listMessages: async (sessionId, after) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return derivePiChatMessages(session.events, after);
    }
  };
};

export const createConfiguredPiSessionAdapter = (env: NodeJS.ProcessEnv = process.env): PiSessionAdapter => (
  env.TESSERAFT_PI_ADAPTER === 'fake' ? createFakePiSessionAdapter() : createRealPiSessionAdapter()
);
