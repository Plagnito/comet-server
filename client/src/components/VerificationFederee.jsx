// Correspondant d'un AUTRE serveur Comet : badge, numéro de sécurité, avertissement de
// changement de clé. Le numéro est le même chez les deux personnes : le comparer de vive
// voix (ou par un autre canal) prouve qu'aucun serveur n'a substitué de clé.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { numeroDeSecurite } from '../crypto.js';
import { estVerifie, marquerVerifie } from '../federation.js';
import Icon from './Icon.jsx';

let etatPromis = null;
const etatFederation = () => (etatPromis ||= api.get('/federation/etat').catch(() => ({ active: false })));

// Sert aussi pour un compte du MÊME serveur (`personne.cle` = { adresse, publicKey }) :
// c'est le serveur qui distribue les clés de ses comptes, et seul ce numéro comparé hors
// bande permet de vérifier qu'il n'a pas remis la sienne à la place.
export default function VerificationFederee({ personne }) {
  const { user, myPublicKey } = useAuth();
  const f = personne?.federe;
  const locale = !f && personne?.cle?.publicKey && personne.cle.adresse !== user?.email ? personne.cle : null;
  const adresseAutre = f ? personne?.email : locale?.adresse;
  const cleAutre = f ? f.publicKey : locale?.publicKey;
  const [ouvert, setOuvert] = useState(false);
  const [numero, setNumero] = useState(null);
  const [verifie, setVerifie] = useState(() => (cleAutre ? estVerifie(adresseAutre, cleAutre) : false));

  useEffect(() => {
    if (!ouvert || !cleAutre || numero) return;
    if (locale) { numeroDeSecurite(user.email, myPublicKey, adresseAutre, cleAutre).then((n) => setNumero(n || '—')); return; }
    etatFederation().then((etat) => {
      if (!etat.adresse) { setNumero('—'); return; }
      numeroDeSecurite(etat.adresse, myPublicKey, adresseAutre, cleAutre).then((n) => setNumero(n || '—'));
    });
  }, [ouvert, cleAutre, numero, myPublicKey, adresseAutre, locale, user?.email]);

  if (!f && !locale) return null;
  const alerte = !!f?.cleChangeeLe && !verifie;
  const basculer = () => { marquerVerifie(adresseAutre, cleAutre, !verifie); setVerifie(!verifie); };

  return (
    <div className="fed-verif" style={{ marginTop: 8 }}>
      {f ? (
        <span className="verified" title={`Livré par le serveur ${f.domaine}, dont la signature a été vérifiée. Le contenu est chiffré de bout en bout : aucun des deux serveurs ne peut le lire.`}>
          <Icon name="badge" size={13} /> {f.domaine}{verifie ? ' · vérifié' : ''}
        </span>
      ) : verifie && (
        <span className="verified" title="Vous avez comparé le numéro de sécurité avec cette personne."><Icon name="badge" size={13} /> Clé vérifiée</span>
      )}
      <button className="btn ghost" style={{ padding: '2px 8px', marginLeft: 6, fontSize: 12 }} onClick={() => setOuvert((v) => !v)}>
        Numéro de sécurité
      </button>
      {alerte && (
        <div className="hint" style={{ color: 'var(--danger)', marginTop: 6 }}>
          La clé de {personne.email} a changé ({new Date(f.cleChangeeLe + 'Z').toLocaleString()}). Comparez à nouveau votre numéro de sécurité.
        </div>
      )}
      {ouvert && (
        <div className="hint" style={{ marginTop: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, max-content)', columnGap: 14, fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 1, lineHeight: 1.7 }}>
            {(numero || 'Calcul…').split(' ').map((g, i) => <span key={i}>{g}</span>)}
          </div>
          <div style={{ margin: '4px 0' }}>{personne.displayName || personne.email} voit le même numéro chez lui. S'il diffère, une clé a été substituée : n'écrivez rien de sensible.</div>
          <button className="btn subtle" style={{ padding: '2px 8px', fontSize: 12 }} onClick={basculer}>
            {verifie ? 'Retirer la vérification' : 'Marquer comme vérifié'}
          </button>
        </div>
      )}
    </div>
  );
}
