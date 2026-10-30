import { db } from '../db.js';

/**
 * REMISE DIRECTE — le serveur oublie un message dès que les appareils l'ont.
 *
 * Ce que l'option achète, exactement. Comet est déjà chiffré de bout en bout : le
 * serveur ne peut PAS lire le courrier. Ce que la remise directe ajoute, c'est de ne
 * plus le CONSERVER — ni le chiffré, ni ses métadonnées — une fois qu'il est arrivé.
 *
 * ⚠️ Ce qu'elle ne peut pas être. « Ne jamais rien stocker » est impossible : si le
 * téléphone est éteint quand le message arrive, il faut bien qu'il attende quelque
 * part. La garantie réelle, celle que l'interface annonce, est donc :
 *
 *     le serveur garde le message jusqu'à ce que CHAQUE appareil enregistré ait
 *     confirmé l'avoir reçu — puis l'efface.
 *
 * Contrepartie assumée et écrite dans l'écran de réglages : il n'existe alors plus
 * aucune copie en ligne. Perdre son téléphone avant que l'ordinateur n'ait récupéré le
 * message, c'est perdre le message. C'est pour cela que l'option est désactivée par
 * défaut.
 *
 * Le délai d'abandon existe pour un cas très concret : un appareil qu'on ne rallumera
 * jamais (volé, jeté, réinitialisé). Sans lui, un seul appareil disparu figerait à
 * jamais toute la boîte de son propriétaire.
 */

/** Passé ce délai, un appareil qui n'est jamais revenu est considéré perdu. */
export const JOURS_AVANT_ABANDON = 30;

/** Un appareil silencieux depuis si longtemps ne bloque plus les purges. */
const JOURS_APPAREIL_INACTIF = 30;

export const remiseDirecteActive = (userId) =>
  !!db.prepare('SELECT remise_directe FROM users WHERE id = ?').get(userId)?.remise_directe;

/**
 * Enregistre (ou rafraîchit) un appareil. La clé est fournie par l'appareil lui-même et
 * doit être stable d'un lancement à l'autre : c'est elle qui dit « c'est encore moi ».
 */
export function enregistrerAppareil(userId, cle, nom, plateforme) {
  const propre = String(cle || '').trim().slice(0, 128);
  if (!propre) return null;
  db.prepare(
    `INSERT INTO appareils (user_id, cle, nom, plateforme, vu_a)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, cle) DO UPDATE SET
       nom = excluded.nom, plateforme = excluded.plateforme, vu_a = datetime('now')`,
  ).run(userId, propre, String(nom || '').slice(0, 80), String(plateforme || '').slice(0, 32));
  return db.prepare('SELECT * FROM appareils WHERE user_id = ? AND cle = ?').get(userId, propre);
}

export const appareilsDe = (userId) =>
  db.prepare('SELECT id, cle, nom, plateforme, vu_a, cree_a FROM appareils WHERE user_id = ? ORDER BY vu_a DESC').all(userId);

export function oublierAppareil(userId, id) {
  const r = db.prepare('DELETE FROM appareils WHERE id = ? AND user_id = ?').run(id, userId);
  // Un appareil retiré ne doit plus retenir les purges qu'il bloquait : sans ce
  // nettoyage, ses accusés manquants garderaient les messages indéfiniment.
  if (r.changes) purgerCeQuiPeutLEtre(userId);
  return !!r.changes;
}

/**
 * Ouvre le suivi d'un message fraîchement livré : une ligne par appareil enregistré.
 *
 * Sans appareil enregistré, on ne crée rien — sinon le message serait effacé aussitôt,
 * avant que quiconque ait pu le lire.
 */
export function suivreLivraison(userId, itemId) {
  if (!remiseDirecteActive(userId)) return 0;
  const appareils = db.prepare('SELECT id FROM appareils WHERE user_id = ?').all(userId);
  if (!appareils.length) return 0;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO remises (item_id, appareil_id, user_id) VALUES (?, ?, ?)',
  );
  for (const a of appareils) ins.run(itemId, a.id, userId);
  return appareils.length;
}

/** Un appareil confirme avoir enregistré ces messages sur son propre stockage. */
export function accuserReception(userId, cleAppareil, itemIds) {
  const appareil = db.prepare('SELECT id FROM appareils WHERE user_id = ? AND cle = ?').get(userId, cleAppareil);
  if (!appareil) return { ok: false, erreur: 'appareil-inconnu' };

  db.prepare("UPDATE appareils SET vu_a = datetime('now') WHERE id = ?").run(appareil.id);
  const maj = db.prepare(
    "UPDATE remises SET recu_a = datetime('now') WHERE item_id = ? AND appareil_id = ? AND recu_a IS NULL",
  );
  let n = 0;
  for (const id of itemIds) if (Number.isInteger(id)) n += maj.run(id, appareil.id).changes;

  const purges = purgerCeQuiPeutLEtre(userId);
  return { ok: true, accuses: n, purges };
}

/**
 * Efface ce qui peut l'être : les messages que tous les appareils ont confirmés, et
 * ceux dont l'attente a trop duré.
 *
 * Les appareils muets depuis longtemps ne comptent plus dans le décompte — c'est ce qui
 * évite qu'un téléphone perdu bloque éternellement la boîte de son propriétaire.
 */
export function purgerCeQuiPeutLEtre(userId = null) {
  const filtre = userId ? 'AND r.user_id = ?' : '';
  // ⚠️ L'ordre suit la position des « ? » dans le SQL, pas l'ordre de lecture du code :
  // le filtre est dans le WHERE, donc AVANT les deux délais du HAVING. Les intervertir
  // ne lève aucune erreur — SQLite compare simplement un identifiant à un nombre de
  // jours, et la purge cesse silencieusement de fonctionner.
  const params = userId
    ? [userId, JOURS_APPAREIL_INACTIF, JOURS_AVANT_ABANDON]
    : [JOURS_APPAREIL_INACTIF, JOURS_AVANT_ABANDON];

  // Un item est mûr quand il ne reste aucun accusé attendu d'un appareil ENCORE actif,
  // ou quand il attend depuis plus longtemps que le délai d'abandon.
  const murs = db.prepare(
    `SELECT r.item_id AS itemId, r.user_id AS userId
       FROM remises r
       JOIN appareils a ON a.id = r.appareil_id
      WHERE 1 = 1 ${filtre}
      GROUP BY r.item_id
     HAVING SUM(CASE
                  WHEN r.recu_a IS NOT NULL THEN 0
                  WHEN a.vu_a < datetime('now', '-' || ? || ' days') THEN 0
                  ELSE 1
                END) = 0
         OR MIN(r.cree_a) < datetime('now', '-' || ? || ' days')`,
  ).all(...params);

  let n = 0;
  for (const m of murs) n += effacerItem(m.userId, m.itemId) ? 1 : 0;
  return n;
}

/**
 * Efface la copie d'UN utilisateur, et le message partagé s'il ne reste plus personne
 * pour le lire.
 *
 * On ne touche jamais aux copies des autres destinataires : chacun décide pour sa
 * boîte, et la remise directe de l'un ne doit pas effacer le courrier de l'autre.
 */
function effacerItem(userId, itemId) {
  const item = db.prepare('SELECT id, message_id FROM mail_items WHERE id = ? AND user_id = ?').get(itemId, userId);
  if (!item) {
    // L'utilisateur l'a déjà supprimé lui-même : le suivi n'a plus d'objet.
    db.prepare('DELETE FROM remises WHERE item_id = ?').run(itemId);
    return false;
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM remises WHERE item_id = ?').run(itemId);
    db.prepare('DELETE FROM mail_items WHERE id = ?').run(itemId);
    db.prepare('DELETE FROM message_keys WHERE message_id = ? AND user_id = ?').run(item.message_id, userId);

    // Plus aucune boîte ne pointe vers ce message : le chiffré lui-même peut partir.
    const restants = db.prepare('SELECT COUNT(*) AS n FROM mail_items WHERE message_id = ?').get(item.message_id).n;
    if (restants === 0) db.prepare('DELETE FROM messages WHERE id = ?').run(item.message_id);

    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('remise directe : purge impossible', e.message);
    return false;
  }
}

/** Ce que l'appareil doit récupérer avant que le serveur ne l'oublie. */
export const enAttentePour = (userId, cleAppareil) =>
  db.prepare(
    `SELECT r.item_id AS itemId
       FROM remises r JOIN appareils a ON a.id = r.appareil_id
      WHERE r.user_id = ? AND a.cle = ? AND r.recu_a IS NULL
      ORDER BY r.item_id`,
  ).all(userId, cleAppareil).map((x) => x.itemId);

/**
 * Le balayage périodique. Il ne sert qu'aux abandons : le cas courant est traité
 * immédiatement, à l'accusé de réception.
 */
export function demarrerPurge(intervalleMs = 60 * 60 * 1000) {
  const t = setInterval(() => {
    try {
      const n = purgerCeQuiPeutLEtre();
      if (n) console.log(`remise directe : ${n} message(s) effacé(s) du serveur`);
    } catch (e) {
      console.error('remise directe : balayage impossible', e.message);
    }
  }, intervalleMs);
  t.unref?.();
  return t;
}
