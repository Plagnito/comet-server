// Jeton uniquement en mémoire : recharger/fermer demande une reconnexion.
const TOKEN_KEY = 'comet.token';
let memoryToken = null;
let pendingAuthChanges = 0;
let deferredExpiry = null;
const AUTH_RESPONSES = new Set(['/auth/login', '/auth/register', '/auth/2fa/verify', '/auth/2fa/setup',
  '/auth/2fa/enable', '/auth/2fa/disable', '/auth/keys', '/auth/set-password', '/auth/reset-password']);
for (const storage of ['localStorage', 'sessionStorage']) {
  for (const key of [TOKEN_KEY, 'comet.privkey']) {
    try { globalThis[storage]?.removeItem(key); } catch {}
  }
}
export const getToken = () => memoryToken;
export const setToken = (token) => {
  const next = token || null;
  if (next === memoryToken) return;
  memoryToken = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('comet:token-changed'));
};
const expireSession = () => {
  setToken(null);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('comet:auth-expired'));
};

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const changesAuth = method === 'POST' && AUTH_RESPONSES.has(path);
  if (changesAuth) pendingAuthChanges++;
  try {
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    if (res.status === 401 && token && token === getToken() && !['/auth/login', '/auth/2fa/verify'].includes(path)) {
      if (pendingAuthChanges) deferredExpiry = token; else expireSession();
    }
    const err = new Error((data && data.error) || `Erreur ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  // Adopter la nouvelle session avant de livrer la réponse au composant : une
  // réponse concurrente portant l'ancien JWT ne doit pas fermer cette session.
  if (changesAuth && typeof data?.token === 'string') setToken(data.token);
  return data;
  } finally {
    if (changesAuth) pendingAuthChanges--;
    if (!pendingAuthChanges && deferredExpiry) {
      const expired = deferredExpiry; deferredExpiry = null;
      if (expired === getToken()) expireSession();
    }
  }
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p) => request('DELETE', p),
};
