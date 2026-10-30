// Fédération — clé d'identité de CE serveur.
//
// Créée au premier besoin, scellée en base avec le secret serveur (comme les mots de passe
// IMAP). Si le scellé devient illisible (COMET_MAIL_SECRET/JWT_SECRET changé), on NE
// régénère PAS en silence : une nouvelle clé sans rotation signée ferait bloquer ce serveur
// par tous ses correspondants. On refuse la fédération et on le dit.
import { generateKeyPairSync } from 'node:crypto';
import { db } from '../db.js';
import { seal, unseal } from '../services/seal.js';
import { priv, signer, empreinte, texteRotation } from './signature.js';
import './schema.js';

let cache = null; // { id, clePublique, clePrivee (KeyObject), rotation }

function charger(ligne) {
  let der;
  try { der = Buffer.from(unseal(ligne.cle_privee), 'base64'); }
  catch {
    throw new Error("Clé d'identité de fédération illisible : le secret serveur (COMET_MAIL_SECRET ou JWT_SECRET) a changé. "
      + 'Rétablissez l\'ancien secret ; régénérer la clé ferait bloquer ce serveur par ses correspondants.');
  }
  return { id: ligne.id, clePublique: ligne.cle_publique, clePrivee: priv(der), rotation: ligne.rotation ? JSON.parse(ligne.rotation) : null };
}

function creerPaire() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privDer: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

export function identite() {
  if (cache) return cache;
  let ligne = db.prepare('SELECT * FROM federation_identite WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!ligne) {
    const p = creerPaire();
    const id = db.prepare('INSERT INTO federation_identite (cle_publique, cle_privee) VALUES (?, ?)').run(p.pub, seal(p.privDer)).lastInsertRowid;
    ligne = db.prepare('SELECT * FROM federation_identite WHERE id = ?').get(id);
  }
  cache = charger(ligne);
  return cache;
}

export const signerAvecIdentite = (texte) => signer(identite().clePrivee, texte);
export const empreinteLocale = () => empreinte(identite().clePublique);

// Rotation : nouvelle paire, annoncée avec une preuve signée par l'ancienne. Les pairs qui
// ont mémorisé l'ancienne l'acceptent sans intervention ; les autres la découvrent.
export function tournerIdentite(domaine) {
  const ancienne = identite();
  const p = creerPaire();
  const date = new Date().toISOString();
  const rotation = { ancienne: ancienne.clePublique, date, signature: signer(ancienne.clePrivee, texteRotation({ domaine, nouvelle: p.pub, date })) };
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE federation_identite SET active = 0 WHERE active = 1').run();
    db.prepare('INSERT INTO federation_identite (cle_publique, cle_privee, rotation) VALUES (?, ?, ?)').run(p.pub, seal(p.privDer), JSON.stringify(rotation));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  cache = null;
  return identite();
}
