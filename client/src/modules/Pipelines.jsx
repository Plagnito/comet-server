import { useEffect, useState, Fragment } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Avatar } from '../components/shell-meta.jsx';
import Icon from '../components/Icon.jsx';

export default function Pipelines() {
  const { user } = useAuth();
  const [pipelines, setPipelines] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [creatingPipe, setCreatingPipe] = useState(false);
  const [pipeForm, setPipeForm] = useState({ name: '', stages: 'À faire, En cours, Revue, Terminé' });
  const [projForm, setProjForm] = useState(null);

  function load() {
    api.get('/pipelines').then((r) => {
      setPipelines(r.pipelines); setCanManage(r.canManage);
      setActiveId((id) => (id != null && r.pipelines.some((p) => p.id === id)) ? id : (r.pipelines[0]?.id ?? null));
    }).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  const active = pipelines.find((p) => p.id === activeId) || null;
  // Créateur du pipeline actif = gère ses projets, comme un manager « pipelines ».
  const isOwner = !!active && active.createdBy === user.id;
  const canMove = (proj) => canManage || isOwner || proj.responsable?.id === user.id;

  async function createPipeline(e) {
    e.preventDefault();
    const stages = pipeForm.stages.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!pipeForm.name.trim() || stages.length === 0) return;
    const r = await api.post('/pipelines', { name: pipeForm.name, stages });
    setCreatingPipe(false); setPipeForm({ name: '', stages: 'À faire, En cours, Revue, Terminé' });
    setActiveId(r.pipeline.id); load();
  }
  async function addProject(e) {
    e.preventDefault();
    if (!projForm.title.trim()) return;
    await api.post(`/pipelines/${active.id}/projects`, { title: projForm.title, description: projForm.description, responsable: projForm.responsable || undefined, stageIndex: projForm.stageIndex });
    setProjForm(null); load();
  }
  async function move(proj, dir) {
    const next = proj.stageIndex + dir;
    if (next < 0 || next >= active.stages.length) return;
    await api.patch(`/pipelines/${active.id}/projects/${proj.id}`, { stageIndex: next }); load();
  }
  async function delProject(proj) {
    if (!window.confirm('Supprimer ce projet ?')) return;
    await api.del(`/pipelines/${active.id}/projects/${proj.id}`); load();
  }
  async function delPipeline() {
    if (!window.confirm(`Supprimer le pipeline « ${active.name} » et ses projets ?`)) return;
    await api.del(`/pipelines/${active.id}`); setActiveId(null); load();
  }

  // Progression : projets ayant atteint la dernière étape.
  const total = active ? active.projects.length : 0;
  const done = active ? active.projects.filter((p) => p.stageIndex === active.stages.length - 1).length : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const previewStages = pipeForm.stages.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

  return (
    <div className="pane">
      <div className="pane-head">
        <h2>Pipelines</h2>
        <div className="pipe-tabs">
          {pipelines.map((p) => <button key={p.id} className={`pill ${p.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(p.id)}>{p.name}</button>)}
        </div>
        {active && (canManage || isOwner) && <button className="icon-btn" title="Supprimer le pipeline" onClick={delPipeline}><Icon name="trash" size={15} /></button>}
        <button className="btn" onClick={() => setCreatingPipe(true)}><Icon name="plus" size={16} /> Pipeline</button>
      </div>

      {!active ? (
        <div className="empty" style={{ padding: 48 }}>Aucun pipeline. Créez-en un pour suivre l'avancement de vos projets{user.orgName ? ` dans ${user.orgName}` : ''}.</div>
      ) : (
        <>
          {total > 0 && (
            <div className="pipe-progress-wrap">
              <div className="pipe-progress"><div className="pipe-progress-bar" style={{ width: `${pct}%` }} /></div>
              <span className="pipe-progress-label">{done}/{total} terminé{done > 1 ? 's' : ''} · {pct}%</span>
            </div>
          )}

          <div className="pipe-flow">
            {active.stages.map((stage, i) => {
              const cards = active.projects.filter((p) => p.stageIndex === i);
              const isLast = i === active.stages.length - 1;
              return (
                <Fragment key={i}>
                  <div className={`pipe-node ${isLast ? 'final' : ''}`}>
                    <div className="pipe-node-head">
                      <span className="pipe-node-idx">{i + 1}</span>
                      <span className="pipe-node-name">{stage}</span>
                      <span className="pipe-node-count">{cards.length}</span>
                    </div>
                    <div className="pipe-node-body">
                      {cards.length === 0 && <div className="pipe-node-empty">Aucun projet</div>}
                      {cards.map((proj) => (
                        <div key={proj.id} className="pipe-card" style={{ borderLeftColor: proj.color }}>
                          <div className="pc-title">{proj.title}</div>
                          {proj.description && <div className="pc-desc">{proj.description}</div>}
                          <div className="pc-foot">
                            {proj.responsable
                              ? <span className="pc-resp"><Avatar name={proj.responsable.displayName} color={proj.responsable.avatarColor} size={20} /> {proj.responsable.displayName}</span>
                              : <span className="pc-resp muted">Sans responsable</span>}
                            {canMove(proj) && (
                              <span className="pc-actions">
                                <button className="icon-btn sm" disabled={i === 0} onClick={() => move(proj, -1)} title="Étape précédente"><Icon name="chevronLeft" size={14} /></button>
                                <button className="icon-btn sm" disabled={isLast} onClick={() => move(proj, 1)} title="Étape suivante"><Icon name="chevronRight" size={14} /></button>
                                <button className="icon-btn sm" onClick={() => delProject(proj)} title="Supprimer"><Icon name="trash" size={13} /></button>
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    {(canManage || isOwner) && <button className="pipe-add" onClick={() => setProjForm({ stageIndex: i, title: '', description: '', responsable: '' })}><Icon name="plus" size={14} /> Projet</button>}
                  </div>
                  {!isLast && <div className="pipe-arrow" aria-hidden="true"><Icon name="chevronRight" size={22} /></div>}
                </Fragment>
              );
            })}
          </div>
        </>
      )}

      {creatingPipe && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setCreatingPipe(false); }}>
          <form className="modal" onSubmit={createPipeline}>
            <h3>Nouveau pipeline</h3>
            <div className="field"><label>Nom *</label><input value={pipeForm.name} onChange={(e) => setPipeForm({ ...pipeForm, name: e.target.value })} placeholder="ex. Lancement produit" autoFocus /></div>
            <div className="field"><label>Étapes (séparées par des virgules)</label><input value={pipeForm.stages} onChange={(e) => setPipeForm({ ...pipeForm, stages: e.target.value })} /></div>
            <div className="field">
              <label>Aperçu du flux</label>
              <div className="pipe-preview">
                {previewStages.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Ajoutez des étapes…</span>}
                {previewStages.map((s, i) => (
                  <Fragment key={i}>
                    <span className={`pipe-prev-node ${i === previewStages.length - 1 ? 'final' : ''}`}>{s}</span>
                    {i < previewStages.length - 1 && <span className="pipe-prev-arrow"><Icon name="chevronRight" size={16} /></span>}
                  </Fragment>
                ))}
              </div>
            </div>
            <div className="modal-foot"><button type="button" className="btn ghost" onClick={() => setCreatingPipe(false)}>Annuler</button><button className="btn">Créer</button></div>
          </form>
        </div>
      )}

      {projForm && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setProjForm(null); }}>
          <form className="modal" onSubmit={addProject}>
            <h3>Nouveau projet · {active.stages[projForm.stageIndex]}</h3>
            <div className="field"><label>Titre *</label><input value={projForm.title} onChange={(e) => setProjForm({ ...projForm, title: e.target.value })} autoFocus /></div>
            <div className="field"><label>Description</label><textarea rows={3} value={projForm.description} onChange={(e) => setProjForm({ ...projForm, description: e.target.value })} /></div>
            <div className="field"><label>Responsable (e-mail, vous par défaut)</label><input value={projForm.responsable} onChange={(e) => setProjForm({ ...projForm, responsable: e.target.value })} placeholder="lea@comet.mail" /></div>
            <div className="modal-foot"><button type="button" className="btn ghost" onClick={() => setProjForm(null)}>Annuler</button><button className="btn">Ajouter</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
