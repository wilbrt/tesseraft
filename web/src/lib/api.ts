export type RequestJsonOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  requestId?: string;
};

type ErrorEnvelope = { error?: { message?: string }; cli?: { stderr?: string }; status?: string };
type OperationEnvelope<T> = { ok: true; operation: string; result: T };

export class RequestJsonError extends Error {
  constructor(public readonly statusCode: number, public readonly responseBody: ErrorEnvelope & Record<string, unknown>, message: string) {
    super(message);
    this.name = 'RequestJsonError';
  }
}

const operationResult = <T,>(data: unknown): T => {
  if (data && typeof data === 'object' && (data as Partial<OperationEnvelope<T>>).ok === true
      && typeof (data as Partial<OperationEnvelope<T>>).operation === 'string'
      && Object.prototype.hasOwnProperty.call(data, 'result')) {
    return (data as OperationEnvelope<T>).result;
  }
  return data as T;
};

export const requestJson = async <T,>({ method = 'GET', path, body, signal, requestId }: RequestJsonOptions): Promise<T> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (requestId) headers['x-request-id'] = requestId;
  const response = await fetch(path, {
    method,
    headers,
    signal,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data: ErrorEnvelope & Record<string, unknown> = {};
  if (text.trim() !== '') {
    try { data = JSON.parse(text) as ErrorEnvelope & Record<string, unknown>; }
    catch { throw new Error(`Server returned invalid JSON (${response.status})`); }
  }
  if ((!response.ok && data.status !== 'guarded') || data.error) {
    throw new RequestJsonError(response.status, data, data.error?.message || data.cli?.stderr || `Request failed: ${response.status}`);
  }
  return operationResult<T>(data);
};

export const getJson = <T,>(path: string, signal?: AbortSignal): Promise<T> =>
  requestJson<T>({ path, signal });
export const postJson = <T,>(path: string, body: unknown, signal?: AbortSignal): Promise<T> =>
  requestJson<T>({ method: 'POST', path, body, signal });
export const putJson = <T,>(path: string, body: unknown, signal?: AbortSignal): Promise<T> =>
  requestJson<T>({ method: 'PUT', path, body, signal });
export const deleteJson = <T,>(path: string, signal?: AbortSignal): Promise<T> =>
  requestJson<T>({ method: 'DELETE', path, signal });

export type BrowseEntry = { name: string; is_dir: boolean; is_file: boolean };
export type BrowseResult = { root: string; path: string; is_file?: boolean; is_dir?: boolean; entries: BrowseEntry[] };

export const browsePath = (path: string, signal?: AbortSignal): Promise<BrowseResult> =>
  requestJson<BrowseResult>({ path, signal });
