import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

// `can_pipelines` (ou admin) = gère TOUS les pipelines de l'org (projets d'autrui).
const canManage = (u) => !!(u.is_admin || u.can_pipelines);
// Gérer un pipeline donné = manager d'org OU son créateur.
const canEditPipeline = (u, pl) => !!(u.is_admin || u.can_pipelines || pl.created_by === u.id);

// Récupère un pipeline SEULEMENT s'il est dans le périmètre de l'utilisateur : un
// membre d'org voit/édite les pipelines de son org ; un utilisateur sans org ne voit
// que les siens (org_id NULL). Isolation stricte entre organisations (anti-IDOR).
function scopedPipeline(id, u) {
  const pl = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id);
  if (!pl) return null;
  const inScope = u.org_id ? pl.org_id === u.org_id : (pl.org_id == null && pl.created_by === u.id);
  return inScope ? pl : null;
}

function emailToId(raw) {
  let e = String(raw || '').trim().toLowerCase();
  if (!e) return null;
  if (!e.includes('@')) e = `${e}@comet.mail`;
  return db.prepare('SELECT id FROM users WHERE email = ?').get(e)?.id || null;
}
const userView = (id) => (id ? db.prepare('SELECT id, email, display_name AS displayName, avatar_color AS avatarColor FROM users WHERE id = ?').get(id) : null);
const parseStages = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } };

function projectView(p) {
  return {
    id: p.id, pipelineId: p.pipeline_id, title: p.title, description: p.description,
    stageIndex: p.stage_index, color: p.color, responsable: userView(p.responsable_id), updatedAt: p.updated_at,
  };
}
function pipelineView(pl) {
  const stages = parseStages(pl.stages);
  const projects = db.prepare('SELECT * FROM pipeline_projects WHERE pipeline_id = ? ORDER BY stage_index, id').all(pl.id).map(projectView);
  return { id: pl.id, name: pl.name, description: pl.description, stages, createdBy: pl.created_by, projects };
}

// ── Lecture : les pipelines de MON organisation (ou les miens si sans org) ────
router.get('/', (req, res) => {
  const rows = req.user.org_id
    ? db.prepare('SELECT * FROM pipelines WHERE org_id = ? ORDER BY id DESC').all(req.user.org_id)
    : db.prepare('SELECT * FROM pipelines WHERE org_id IS NULL AND created_by = ? ORDER BY id DESC').all(req.user.id);
  res.json({ pipelines: rows.map(pipelineView), canManage: canManage(req.user) });
});

// ── Créer un pipeline (ouvert à tous) — reste dans l'org du créateur ──────────
router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  let stages = Array.isArray(req.body.stages) ? req.body.stages.map((s) => String(s).trim().slice(0, 40)).filter(Boolean) : [];
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  if (stages.length < 2) stages = ['À faire', 'En cours', 'Terminé'];
  const info = db.prepare('INSERT INTO pipelines (name, description, stages, created_by, org_id) VALUES (?, ?, ?, ?, ?)')
    .run(name, String(req.body.description || '').slice(0, 200), JSON.stringify(stages), req.user.id, req.user.org_id || null);
  res.status(201).json({ pipeline: pipelineView(db.prepare('SELECT * FROM pipelines WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const pl = scopedPipeline(req.params.id, req.user);
  if (!pl) return res.status(404).json({ error: 'Pipeline introuvable' });
  if (!(req.user.is_admin || pl.created_by === req.user.id)) return res.status(403).json({ error: 'Réservé au créateur' });
  const sets = [], params = [];
  if ('name' in req.body) { sets.push('name = ?'); params.push(String(req.body.name).slice(0, 80)); }
  if ('description' in req.body) { sets.push('description = ?'); params.push(String(req.body.description).slice(0, 200)); }
  if (Array.isArray(req.body.stages)) { sets.push('stages = ?'); params.push(JSON.stringify(req.body.stages.map((s) => String(s).trim().slice(0, 40)).filter(Boolean))); }
  if (sets.length) { params.push(pl.id); db.prepare(`UPDATE pipelines SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  res.json({ pipeline: pipelineView(db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pl.id)) });
});

router.delete('/:id', (req, res) => {
  const pl = scopedPipeline(req.params.id, req.user);
  if (!pl) return res.status(404).json({ error: 'Pipeline introuvable' });
  if (!(req.user.is_admin || pl.created_by === req.user.id)) return res.status(403).json({ error: 'Réservé au créateur' });
  db.prepare('DELETE FROM pipelines WHERE id = ?').run(pl.id);
  res.json({ ok: true });
});

// ── Projets ──────────────────────────────────────────────────────────────────
router.post('/:id/projects', (req, res) => {
  const pl = scopedPipeline(req.params.id, req.user);
  if (!pl) return res.status(404).json({ error: 'Pipeline introuvable' });
  if (!canEditPipeline(req.user, pl)) return res.status(403).json({ error: 'Non autorisé' });
  const title = String(req.body.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const stages = parseStages(pl.stages);
  const stageIndex = Math.min(Math.max(0, parseInt(req.body.stageIndex, 10) || 0), stages.length - 1);
  const responsableId = req.body.responsable ? emailToId(req.body.responsable) : req.user.id;
  const info = db.prepare('INSERT INTO pipeline_projects (pipeline_id, title, description, stage_index, responsable_id, color, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(pl.id, title, String(req.body.description || '').slice(0, 500), stageIndex, responsableId, req.body.color || '#4f46e5', req.user.id);
  res.status(201).json({ project: projectView(db.prepare('SELECT * FROM pipeline_projects WHERE id = ?').get(info.lastInsertRowid)) });
});

// Déplacer / éditer un projet : le responsable, le créateur du pipeline, un
// gestionnaire de pipelines, ou un admin — dans le périmètre de l'org uniquement.
router.patch('/:id/projects/:pid', (req, res) => {
  const pl = scopedPipeline(req.params.id, req.user);
  if (!pl) return res.status(404).json({ error: 'Pipeline introuvable' });
  const p = db.prepare('SELECT * FROM pipeline_projects WHERE id = ? AND pipeline_id = ?').get(req.params.pid, pl.id);
  if (!p) return res.status(404).json({ error: 'Projet introuvable' });
  const allowed = canEditPipeline(req.user, pl) || p.responsable_id === req.user.id;
  if (!allowed) return res.status(403).json({ error: 'Seul le responsable peut déplacer ce projet' });
  const stages = parseStages(pl.stages);
  const sets = [], params = [];
  if ('stageIndex' in req.body) { sets.push('stage_index = ?'); params.push(Math.min(Math.max(0, parseInt(req.body.stageIndex, 10) || 0), stages.length - 1)); }
  if ('title' in req.body) { sets.push('title = ?'); params.push(String(req.body.title).slice(0, 100)); }
  if ('description' in req.body) { sets.push('description = ?'); params.push(String(req.body.description).slice(0, 500)); }
  if ('color' in req.body) { sets.push('color = ?'); params.push(String(req.body.color)); }
  if ('responsable' in req.body) { sets.push('responsable_id = ?'); params.push(emailToId(req.body.responsable)); }
  if (sets.length) { sets.push("updated_at = datetime('now')"); params.push(p.id); db.prepare(`UPDATE pipeline_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  res.json({ project: projectView(db.prepare('SELECT * FROM pipeline_projects WHERE id = ?').get(p.id)) });
});

router.delete('/:id/projects/:pid', (req, res) => {
  const pl = scopedPipeline(req.params.id, req.user);
  if (!pl) return res.status(404).json({ error: 'Pipeline introuvable' });
  const p = db.prepare('SELECT * FROM pipeline_projects WHERE id = ? AND pipeline_id = ?').get(req.params.pid, pl.id);
  if (!p) return res.status(404).json({ error: 'Projet introuvable' });
  if (!(canEditPipeline(req.user, pl) || p.responsable_id === req.user.id)) return res.status(403).json({ error: 'Non autorisé' });
  db.prepare('DELETE FROM pipeline_projects WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

export default router;
