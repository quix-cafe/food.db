export class ApiError extends Error {}

// Test mode (per browser): every request carries X-Test-Data, and whatever the server adds
// while it's on is marked test data, removable in one go from the Backup page.
const TEST_KEY = 'food.db:test-mode';
const TEST_EVENT = 'food.db:test-mode';
let testMode = (() => {
  try { return localStorage.getItem(TEST_KEY) === '1'; } catch { return false; }
})();
export const isTestMode = () => testMode;
export function setTestMode(on) {
  testMode = on;
  try { on ? localStorage.setItem(TEST_KEY, '1') : localStorage.removeItem(TEST_KEY); } catch { /* still on for this tab */ }
  window.dispatchEvent(new Event(TEST_EVENT));
}
export const onTestModeChanged = (fn) => {
  window.addEventListener(TEST_EVENT, fn);
  return () => window.removeEventListener(TEST_EVENT, fn);
};

/** JSON fetch against /api; a FormData body is sent as multipart. Throws ApiError with the server's message. */
export async function api(path, { method = 'GET', body } = {}) {
  const multipart = body instanceof FormData;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined && !multipart ? { 'content-type': 'application/json' } : {}),
        ...(testMode ? { 'x-test-data': '1' } : {}),
      },
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
