export const getJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data;
};

export const postJson = async <T,>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if ((!response.ok && data.status !== 'guarded') || data.error) {
    const message = data.error?.message || data.cli?.stderr || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data;
};

export const putJson = async <T,>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data;
};

export type BrowseEntry = { name: string; is_dir: boolean; is_file: boolean };
export type BrowseResult = { root: string; path: string; is_file?: boolean; is_dir?: boolean; entries: BrowseEntry[] };

export const browsePath = async (url: string): Promise<BrowseResult> => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data as BrowseResult;
};

export const deleteJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data;
};
