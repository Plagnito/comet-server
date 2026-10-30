// File d'attente d'envoi : si le POST échoue faute de réseau (utilisateur hors
// ligne), le message CHIFFRÉ est conservé localement et réessayé chaque minute
// (et au retour en ligne). Une erreur HTTP (4xx/5xx) n'est PAS mise en file
// (échec définitif) pour éviter les boucles.
import { api } from './api.js';

const KEY = 'comet.outbox';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const write = (l) => { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch {} };

const listeners = new Set();
const emit = () => { const n = read().length; listeners.forEach((f) => { try { f(n); } catch {} }); };
export const onOutboxChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const outboxSize = () => read().length;

export function enqueue(payload) {
  const l = read();
  l.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, payload, at: Date.now() });
  write(l); emit();
}

// Envoi « résilient » : hors ligne ou échec réseau → file d'attente.
export async function sendMail(payload) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { enqueue(payload); return { queued: true }; }
  try { await api.post('/mail', payload); return { ok: true }; }
  catch (e) { if (e && e.status) throw e; enqueue(payload); return { queued: true }; }
}

// Réessaie toute la file ; renvoie le nombre restant.
export async function flushOutbox() {
  const l = read();
  if (!l.length) return 0;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return l.length; // hors ligne : on garde tout

  const remaining = [];
  for (const item of l) {
    try { await api.post('/mail', item.payload); }
    catch (e) { if (!(e && e.status)) remaining.push(item); /* erreur réseau → on garde ; erreur HTTP → on abandonne */ }
  }
  write(remaining); emit();
  return remaining.length;
}
