export class ApiError extends Error {}

/** JSON fetch against /api; a FormData body is sent as multipart. Throws ApiError with the server's message. */
export async function api(path, { method = 'GET', body } = {}) {
  const multipart = body instanceof FormData;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined && !multipart ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined || multipart ? body : JSON.stringify(body),
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

/** Multipart body with `files` under the `images` field, plus plain text fields. */
export function imageForm(files, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, v);
  for (const f of files) fd.append('images', f, f.name);
  return fd;
}
