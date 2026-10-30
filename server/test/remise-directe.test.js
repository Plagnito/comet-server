// REMISE DIRECTE — le serveur oublie un message dès que les appareils l'ont.
//
// Comet est déjà chiffré de bout en bout : le serveur ne peut PAS lire le courrier.
// Ce que cette option ajoute, c'est de ne plus le CONSERVER. La question que ce
// fichier doit trancher n'est donc pas « est-ce que ça marche » mais :
//
//   • le message reste-t-il tant qu'UN SEUL appareil ne l'a pas confirmé ? (sinon on
//     perd du courrier, et c'est irréversible) ;
//   • disparaît-il VRAIMENT quand tous ont confirmé — chiffré compris, pas seulement
//     la vue de la boîte ? ;
//   • un utilisateur qui n'a pas activé l'option est-il totalement épargné ? ;
//   • un appareil perdu peut-il figer la boîte pour toujours ?
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db.js';
import { deliverMessage } from '../src/services/mail.js';
import {
  enregistrerAppareil, appareilsDe, oublierAppareil,
  accuserReception, enAttentePour, purgerCeQuiPeutLEtre, suivreLivraison,
} from '../src/services/remisedirecte.js';

const idDe = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

let expediteur, destinataire;

beforeEach(() => {
  expediteur = idDe('lea@comet.mail');
  destinataire = idDe('marc@comet.mail');
  // On repart d'un état connu : ni appareils, ni suivis, ni option.
  db.prepare('DELETE FROM remises WHERE user_id = ?').run(destinataire);
  db.prepare('DELETE FROM appareils WHERE user_id = ?').run(destinataire);
  db.prepare('UPDATE users SET remise_directe = 0 WHERE id = ?').run(destinataire);
});

const envoyer = (objet) => deliverMessage({
  senderId: expediteur, to: [destinataire], subject: objet, body: 'corps', copyToSender: false,
});

const itemDe = (messageId) =>
  db.prepare('SELECT id FROM mail_items WHERE message_id = ? AND user_id = ?').get(messageId, destinataire);

const messageExiste = (id) => !!db.prepare('SELECT 1 AS x FROM messages WHERE id = ?').get(id);

describe('sans remise directe, rien ne change', () => {
  it('aucun suivi n\'est ouvert et le message reste', () => {
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    const m = envoyer('ordinaire');

    expect(db.prepare('SELECT COUNT(*) AS n FROM remises WHERE user_id = ?').get(destinataire).n).toBe(0);
    expect(purgerCeQuiPeutLEtre(destinataire)).toBe(0);
    expect(messageExiste(m.id)).toBe(true);
    expect(itemDe(m.id)).toBeTruthy();
  });
});

describe('avec remise directe', () => {
  beforeEach(() => {
    db.prepare('UPDATE users SET remise_directe = 1 WHERE id = ?').run(destinataire);
  });

  it('sans appareil enregistré, le message n\'est PAS effacé', () => {
    // Le cas le plus dangereux : effacer un message que personne n'a jamais reçu.
    const m = envoyer('personne pour le lire');
    expect(db.prepare('SELECT COUNT(*) AS n FROM remises WHERE user_id = ?').get(destinataire).n).toBe(0);
    expect(purgerCeQuiPeutLEtre(destinataire)).toBe(0);
    expect(messageExiste(m.id)).toBe(true);
  });

  it('attend que TOUS les appareils aient confirmé', () => {
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    enregistrerAppareil(destinataire, 'pc-1', 'PC', 'windows');

    const m = envoyer('à deux appareils');
    const item = itemDe(m.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM remises WHERE item_id = ?').get(item.id).n).toBe(2);

    // Le téléphone confirme : le message doit RESTER, l'ordinateur ne l'a pas encore.
    const r1 = accuserReception(destinataire, 'tel-1', [item.id]);
    expect(r1.ok).toBe(true);
    expect(r1.accuses).toBe(1);
    expect(r1.purges).toBe(0);
    expect(messageExiste(m.id)).toBe(true);

    // L'ordinateur confirme à son tour : maintenant le serveur peut oublier.
    const r2 = accuserReception(destinataire, 'pc-1', [item.id]);
    expect(r2.purges).toBe(1);

    expect(itemDe(m.id)).toBeUndefined();
    expect(messageExiste(m.id)).toBe(false);
    // Le chiffré ET la clé partent : il ne doit rien rester d'exploitable.
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_keys WHERE message_id = ?').get(m.id).n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM remises WHERE item_id = ?').get(item.id).n).toBe(0);
  });

  it('dit à un appareil ce qu\'il lui reste à récupérer', () => {
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    const a = envoyer('un'); const b = envoyer('deux');
    const ia = itemDe(a.id).id, ib = itemDe(b.id).id;

    expect(enAttentePour(destinataire, 'tel-1').sort()).toEqual([ia, ib].sort());
    accuserReception(destinataire, 'tel-1', [ia]);
    // `a` est parti, `b` reste : la liste ne contient plus que ce qui manque.
    expect(enAttentePour(destinataire, 'tel-1')).toEqual([ib]);
  });

  it('n\'efface QUE la copie du destinataire, jamais celle des autres', () => {
    // Le point qui compte : la remise directe de l'un ne doit pas trouer la boîte
    // de l'autre. Le message est partagé, les copies ne le sont pas.
    const troisieme = idDe('sophie@comet.mail');
    db.prepare('UPDATE users SET remise_directe = 0 WHERE id = ?').run(troisieme);
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');

    const m = deliverMessage({
      senderId: expediteur, to: [destinataire, troisieme],
      subject: 'à deux', body: 'corps', copyToSender: false,
    });
    accuserReception(destinataire, 'tel-1', [itemDe(m.id).id]);

    expect(itemDe(m.id)).toBeUndefined();                     // la copie de Marc est partie
    expect(messageExiste(m.id)).toBe(true);                    // le message reste
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_items WHERE message_id = ? AND user_id = ?')
      .get(m.id, troisieme).n).toBe(1);                        // Sophie l'a toujours
  });

  it('un appareil retiré ne bloque plus les purges', () => {
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    const perdu = enregistrerAppareil(destinataire, 'tel-perdu', 'Vieux', 'android');

    const m = envoyer('bloqué par un fantôme');
    accuserReception(destinataire, 'tel-1', [itemDe(m.id).id]);
    expect(messageExiste(m.id)).toBe(true);                    // le fantôme retient encore

    oublierAppareil(destinataire, perdu.id);
    expect(messageExiste(m.id)).toBe(false);                   // il ne retient plus rien
  });

  it('abandonne un appareil silencieux au bout du délai', () => {
    // Sans cette issue, un téléphone volé figerait la boîte de son propriétaire pour
    // toujours : chaque message attendrait un accusé qui ne viendrait jamais.
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    const m = envoyer('vieux message');
    const item = itemDe(m.id);

    expect(purgerCeQuiPeutLEtre(destinataire)).toBe(0);        // trop tôt

    db.prepare("UPDATE appareils SET vu_a = datetime('now', '-40 days') WHERE user_id = ?").run(destinataire);
    db.prepare("UPDATE remises SET cree_a = datetime('now', '-40 days') WHERE item_id = ?").run(item.id);

    expect(purgerCeQuiPeutLEtre(destinataire)).toBe(1);
    expect(messageExiste(m.id)).toBe(false);
  });

  it('un appareil inconnu ne peut rien accuser', () => {
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    const m = envoyer('protégé');
    const r = accuserReception(destinataire, 'appareil-invente', [itemDe(m.id).id]);
    expect(r.ok).toBe(false);
    expect(r.erreur).toBe('appareil-inconnu');
    expect(messageExiste(m.id)).toBe(true);
  });

  it('enregistrer deux fois le même appareil ne le duplique pas', () => {
    // Chaque lancement de l'application appelle cette route. Sans idempotence, on
    // accumulerait des appareils fantômes qui retiendraient toutes les purges.
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    enregistrerAppareil(destinataire, 'tel-1', 'Note10 renommé', 'android');
    const liste = appareilsDe(destinataire);
    expect(liste.length).toBe(1);
    expect(liste[0].nom).toBe('Note10 renommé');
  });

  it('accuser deux fois ne compte qu\'une fois', () => {
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    enregistrerAppareil(destinataire, 'pc-1', 'PC', 'windows');
    const m = envoyer('doublon');
    const item = itemDe(m.id).id;

    expect(accuserReception(destinataire, 'tel-1', [item]).accuses).toBe(1);
    expect(accuserReception(destinataire, 'tel-1', [item]).accuses).toBe(0);
    expect(messageExiste(m.id)).toBe(true);                    // le PC n'a toujours rien confirmé
  });

  it('suivre une livraison est sans effet si l\'option est coupée entre-temps', () => {
    enregistrerAppareil(destinataire, 'tel-1', 'Note10', 'android');
    db.prepare('UPDATE users SET remise_directe = 0 WHERE id = ?').run(destinataire);
    const m = envoyer('option coupée');
    expect(suivreLivraison(destinataire, itemDe(m.id).id)).toBe(0);
  });
});
