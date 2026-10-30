// Fédération — ce que l'APPAREIL vérifie et retient des autres serveurs Comet.
//
// Notre serveur nous relaie la clé de Dominique (serveur-b.fr) avec une attestation signée
// par serveur-b.fr, et la clé de serveur-b.fr. On vérifie l'attestation, puis on retient la
// clé de serveur-b.fr sur cet appareil (premier contact). Ensuite, si notre propre serveur
// présentait une AUTRE clé pour serveur-b.fr — sans rotation signée par l'ancienne —
// l'envoi est refusé : il faudrait soit une rotation légitime, soit une substitution.
import { verifierEnregistrementCle, verifierRotationServeur } from './crypto.js';

const CLE_SERVEURS = 'comet.fed.serveurs';   // domaine → clé Ed25519 retenue
const CLE_VERIFIES = 'comet.fed.verifies';   // « adresse|clé » → date de vérification

const lire = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } };
const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

/**
 * @param {object[]} destinataires  entrées de /users/recipients portant `federe`
 * @returns {Promise<{ erreurs: string[], avertissements: string[] }>}
 */
export async function verifierDestinatairesFederes(destinataires) {
  const erreurs = []; const avertissements = [];
  const serveurs = lire(CLE_SERVEURS);
  for (const r of destinataires) {
    const f = r.federe;
    const { domaine } = f;
    const cleServeur = f.serveur?.cle;
    if (!cleServeur || !f.enregistrement || f.enregistrement.cle !== r.publicKey || f.enregistrement.adresse !== r.email) {
      erreurs.push(`${r.email} : attestation de clé incomplète.`); continue;
    }
    const retenue = serveurs[domaine];
    if (retenue && retenue !== cleServeur) {
      if (await verifierRotationServeur(domaine, retenue, cleServeur, f.serveur.rotation)) {
        avertissements.push(`Le serveur ${domaine} a changé de clé (rotation signée par l'ancienne).`);
      } else {
        erreurs.push(`La clé du serveur ${domaine} n'est plus celle que cet appareil connaît, sans preuve de rotation. Envoi bloqué : vérifiez auprès de votre administrateur.`);
        continue;
      }
    }
    if (!(await verifierEnregistrementCle(f.enregistrement, cleServeur))) {
      erreurs.push(`${r.email} : la clé n'est pas attestée par ${domaine}. Envoi bloqué.`); continue;
    }
    serveurs[domaine] = cleServeur;
    if (f.cleChangeeLe && !estVerifie(r.email, r.publicKey)) {
      avertissements.push(`La clé de ${r.email} a changé (${new Date(f.cleChangeeLe + 'Z').toLocaleString()}). Comparez votre numéro de sécurité avant d'écrire quelque chose de sensible.`);
    }
  }
  ecrire(CLE_SERVEURS, serveurs);
  return { erreurs, avertissements };
}

export const estVerifie = (adresse, cle) => !!lire(CLE_VERIFIES)[`${String(adresse).toLowerCase()}|${cle}`];
export function marquerVerifie(adresse, cle, oui = true) {
  const v = lire(CLE_VERIFIES);
  const k = `${String(adresse).toLowerCase()}|${cle}`;
  if (oui) v[k] = new Date().toISOString(); else delete v[k];
  ecrire(CLE_VERIFIES, v);
}
