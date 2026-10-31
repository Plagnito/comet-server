#!/usr/bin/env node
/**
 * Comet Connecteur — agent autonome d'organisation.
 *
 * Se connecte à votre serveur Comet et :
 *   1. ARCHIVE toutes les données de l'organisation (snapshots horodatés, locaux).
 *      Les messages/chat sont chiffrés de bout en bout : l'archive ne contient que du
 *      chiffré — le connecteur ne peut pas les lire (sauvegarde « aveugle »).
 *   2. CRÉE automatiquement les salons de conférence des événements à venir marqués
 *      « salle de conférence » (prévient les participants).
 *   3. PRÉPARE l'espace de stockage partagé selon la configuration du serveur.
 *
 * Aucune dépendance (Node 18+). Téléchargé depuis Paramètres → Options avancées.
 *
 * Utilisation :
 *   node comet-connector.mjs --server https://comet.votre-domaine.fr --key cmtk_xxx
 * Options :
 *   --server URL     serveur Comet (def: http://localhost:4800)
 *   --key KEY        clé de connecteur (générée dans l'app par un admin) [requis]
 *   --archive DIR    dossier d'archives (def: ./comet-archive)
 *   --interval SEC   intervalle entre deux passages (def: 60)
 *   --ai-url URL     fournisseur IA de l'organisation, REQUIS pour l'assistant IA
 *                    (ex. Ollama : http://localhost:11434/api/generate)
 *   --ai-model NOM   modèle passé au fournisseur (def: qwen3:0.6b)
 *   --once           un seul passage puis quitter
 *
 *   4. ALIMENTE l'ASSISTANT IA : dépile les questions posées dans Comet, interroge
 *      l'IA de l'organisation et renvoie les réponses. Sans --ai-url, le connecteur
 *      le SIGNALE au serveur et l'application affiche « aucun fournisseur IA
 *      configuré » au lieu de laisser les questions sans réponse.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const has = (name) => args.includes(`--${name}`);

const SERVER = (opt('server', 'http://localhost:4800')).replace(/\/$/, '');
const KEY = opt('key', process.env.COMET_CONNECTOR_KEY);
const ARCHIVE_DIR = opt('archive', './comet-archive');
const PROTOOLS_FILE = opt('protools', './comet-protools.json'); // parc auto-hébergé (outils pro)
const AI_URL = opt('ai-url', process.env.COMET_AI_URL || '');   // IA locale (ex. Ollama : http://localhost:11434/api/generate)
const AI_MODEL = opt('ai-model', process.env.COMET_AI_MODEL || 'qwen3:0.6b');
const INTERVAL = Math.max(10, parseInt(opt('interval', '60'), 10) || 60);
const ONCE = has('once');

if (!KEY) {
  console.error('Erreur : clé de connecteur manquante. Utilisez --key cmtk_… (générée dans Paramètres → Options avancées).');
  process.exit(1);
}

const headers = { 'X-Connector-Key': KEY };
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function api(path, init = {}) {
  const r = await fetch(SERVER + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!r.ok) {
    const corps = await r.json().catch(() => ({}));
    const e = new Error(corps.error ? `${path} → ${corps.error}` : `${path} → HTTP ${r.status}`);
    e.status = r.status; e.droit = corps.droit;
    throw e;
  }
  return r.json();
}

// Chaque clé n'a que certains droits (export, visio, ia…), choisis par
// l'administrateur. Une tâche sans son droit est sautée ; un refus n'arrête pas les
// autres tâches, et on ne le signale qu'une fois.
const refusSignales = new Set();
async function tache(nom, droit, droits, fn) {
  if (droits && !droits.includes(droit)) {
    if (!refusSignales.has(nom)) { log(`${nom} : sautée, cette clé n'a pas le droit « ${droit} ».`); refusSignales.add(nom); }
    return;
  }
  try { await fn(); refusSignales.delete(nom); } catch (e) {
    if (e.status === 403) {
      if (!refusSignales.has(nom)) { log(`${nom} : cette clé n'a pas le droit « ${e.droit || droit} » — tâche sautée.`); refusSignales.add(nom); }
    } else log(`${nom} : erreur — ${e.message}`);
  }
}

async function archive() {
  const snap = await api('/api/connector/export');
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const file = join(ARCHIVE_DIR, `comet-${stamp()}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2));
  const counts = Object.fromEntries(Object.entries(snap).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  log(`Archive écrite → ${file}`);
  log(`  ${snap.users?.length || 0} comptes · ${snap.messages?.length || 0} messages (chiffrés) · ${snap.events?.length || 0} événements · ${snap.pipelineProjects?.length || 0} projets`);
  return counts;
}

async function autoRooms() {
  const { announced } = await api('/api/connector/process', { method: 'POST' });
  if (announced > 0) log(`Salon(s) de conférence annoncé(s) : ${announced}`);
  return announced;
}

async function ensureStorage(cfg) {
  const storage = cfg?.storage;
  if (storage?.enabled && storage.path) {
    try { mkdirSync(storage.path, { recursive: true }); log(`Stockage partagé prêt → ${storage.path}`); }
    catch (e) { log(`Stockage partagé : impossible de créer ${storage.path} (${e.message})`); }
  }
}

// Outils pro auto-hébergés : si le serveur a choisi le connecteur comme source,
// on publie le parc local (fichier comet-protools.json) — le connecteur REMPLACE
// l'API externe. Format : { assets: [{ id, name, type, status, serial, model }] }.
function computeDashboard(assets) {
  const byTypeMap = {};
  for (const a of assets) { const t = a.type || 'autre'; byTypeMap[t] = (byTypeMap[t] || 0) + 1; }
  const byType = Object.entries(byTypeMap).map(([id, n]) => ({ id, name: id, n }));
  return { assets: { total: assets.length, byType, byStatus: [] }, tickets: { total: 0, open: 0 }, software: 0, licenses: 0, contracts: 0, projects: 0, reservations: 0, expiries: { total: 0 } };
}
async function pushProTools(cfg) {
  if (cfg?.protools?.source !== 'connector') return; // le serveur n'utilise pas le connecteur comme source
  if (!existsSync(PROTOOLS_FILE)) { log(`Outils pro : ${PROTOOLS_FILE} absent — créez-le pour publier votre parc.`); return; }
  let data; try { data = JSON.parse(readFileSync(PROTOOLS_FILE, 'utf8')); } catch (e) { log('Outils pro : JSON invalide —', e.message); return; }
  const assets = Array.isArray(data.assets) ? data.assets : (Array.isArray(data) ? data : []);
  const dashboard = data.dashboard || computeDashboard(assets);
  const r = await api('/api/connector/protools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dashboard, assets }) });
  log(`Outils pro : ${r.assets} actif(s) publié(s) (le connecteur remplace l'API).`);
}

// Assistant IA : récupère les questions en attente, interroge l'IA locale de
// l'organisation (ex. Ollama), puis renvoie la réponse. L'IA tourne CHEZ l'org.
async function callAI(prompt) {
  const r = await fetch(AI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: AI_MODEL, prompt, stream: false }) });
  if (!r.ok) throw new Error(`IA HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  // Tolère Ollama (.response), OpenAI (.choices[].message.content) et variantes.
  const out = j.response || j.choices?.[0]?.message?.content || j.choices?.[0]?.text || j.message?.content || '';
  return String(out || '').slice(0, 20000) || '(réponse vide)';
}
async function processAi(cfg) {
  if (!cfg?.ai?.enabled) return;
  // On PRÉVIENT toujours le serveur de notre état, même (surtout) sans fournisseur
  // IA : c'est ainsi que l'application peut dire franchement à l'utilisateur que
  // l'assistant est activé mais sans moteur, au lieu de le faire attendre pour rien.
  const { jobs } = await api(`/api/connector/ai/pending?ready=${AI_URL ? 1 : 0}`);
  if (!AI_URL) { log('IA : activée côté serveur mais --ai-url absent — signalé à Comet (l\'assistant l\'affichera).'); return; }
  for (const job of (jobs || [])) {
    try {
      const answer = await callAI(job.prompt);
      await api('/api/connector/ai/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, answer }) });
      log(`IA : réponse au travail #${job.id}`);
    } catch (e) {
      await api('/api/connector/ai/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, error: e.message }) }).catch(() => {});
      log(`IA : échec du travail #${job.id} — ${e.message}`);
    }
  }
}

async function tick() {
  let cfg = null;
  try { cfg = await api('/api/connector/config'); } catch (e) {
    log('Configuration indisponible :', e.message);
    if (e.status === 401) return; // clé inconnue, révoquée ou expirée : rien d'autre ne passera
  }
  // Un serveur d'une version antérieure ne renvoie pas `droits` : on tente tout.
  const droits = Array.isArray(cfg?.droits) ? cfg.droits : null;
  await tache('Archive', 'export', droits, archive);
  await tache('Salons de visio', 'visio', droits, autoRooms);
  if (cfg) {
    await ensureStorage(cfg);
    // Seulement si le serveur a choisi le connecteur comme source de son parc.
    if (cfg.protools?.source === 'connector') await tache('Outils pro', 'outils-pro', droits, () => pushProTools(cfg));
    await tache('Assistant IA', 'ia', droits, () => processAi(cfg));
  }
}

log(`Comet Connecteur → ${SERVER}`);
await tick();
if (!ONCE) {
  log(`En écoute (toutes les ${INTERVAL}s). Ctrl+C pour arrêter.`);
  setInterval(tick, INTERVAL * 1000);
}
