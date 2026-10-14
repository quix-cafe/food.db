export class ApiError extends Error {}

/** JSON fetch against /api. Throws ApiError carrying the server's message. */
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check that it is running.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`);
  return data;
}

// Lightweight "something changed" signal so open views refetch after a save elsewhere.
const DATA_EVENT = 'kitchen:data-changed';
export const notifyDataChanged = () => window.dispatchEvent(new Event(DATA_EVENT));
export const onDataChanged = (fn) => {
  window.addEventListener(DATA_EVENT, fn);
  return () => window.removeEventListener(DATA_EVENT, fn);
};
