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
