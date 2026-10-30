import { describe, it, expect } from 'vitest';
import {
  BAC_A_SABLE, documentCourriel, estDistante, hote, htmlEstVide, nettoyer,
  phraseImagesBloquees, politiqueSecurite, ressourcesDistantes, texteDepuisHtml,
} from '../src/mailhtml.js';

// Pourquoi ces tests existent : un pixel espion est une image transparente de 1×1, et
// l'écran est RIGOUREUSEMENT identique qu'on l'ait chargée ou non. Aucune relecture,
// aucun essai à l'œil ne peut établir que rien n'est parti — seuls des tests le peuvent.

describe('ce qui sort de la machine', () => {
  it('ne compte comme distante que http et https', () => {
    expect(estDistante('https://exemple.org/p.gif')).toBe(true);
    expect(estDistante('HTTP://Exemple.org/p.gif')).toBe(true);
    // `data:` n'est pas distante : l'image est DÉJÀ dans le message, la charger ne
    // prévient personne. La bloquer casserait les logos sans rien protéger.
    expect(estDistante('data:image/gif;base64,R0lGOD')).toBe(false);
    expect(estDistante('cid:piece-1')).toBe(false);
    expect(estDistante('/relatif.png')).toBe(false);
    expect(estDistante('')).toBe(false);
    expect(estDistante(null)).toBe(false);
  });

  it('nomme l’hôte sans le mot de passe ni le port', () => {
    expect(hote('https://images.exemple.org/a.png')).toBe('images.exemple.org');
    // Sans ce retrait, on afficherait le mot de passe de l'adresse dans le bandeau.
    expect(hote('https://jean:secret@pixel.suivi.tld/1.gif')).toBe('pixel.suivi.tld');
    expect(hote('http://exemple.org:8080/a.png')).toBe('exemple.org');
    expect(hote('https://[::1]:9000/a.png')).toBe('[::1]');
    expect(hote('pas-une-adresse')).toBe(null);
  });

  it('relève les images, les srcset, les fonds et les url() CSS', () => {
    const html = `
      <img src="https://img.exemple.org/entete.png">
      <img srcset="https://cdn1.tld/a.png 1x, https://cdn2.tld/a@2x.png 2x">
      <td background="http://fond.tld/f.gif"></td>
      <div style="background:url('https://css.tld/motif.png')"></div>
      <img src="data:image/gif;base64,R0lGOD">`;
    const { hotes } = ressourcesDistantes(html);
    expect(hotes).toEqual(['cdn1.tld', 'cdn2.tld', 'css.tld', 'fond.tld', 'img.exemple.org']);
  });

  it('ne compte PAS un lien : il ne prévient personne tant qu’on ne le suit pas', () => {
    const { hotes } = ressourcesDistantes('<a href="https://boutique.tld/promo">Voir</a>');
    expect(hotes).toEqual([]);
  });

  it('attrape le pixel espion d’un domaine différent de celui des images', () => {
    // Le cas qui justifie de NOMMER les domaines : la marque affiche ses visuels depuis
    // son propre domaine, et mesure l'ouverture depuis un autre.
    const html = '<img src="https://images.marque.fr/logo.png">'
      + '<img src="https://t.pisteur.example/o.gif?u=42" width="1" height="1">';
    expect(ressourcesDistantes(html).hotes).toEqual(['images.marque.fr', 't.pisteur.example']);
  });
});

describe('le bandeau nomme les domaines', () => {
  it('ne dit rien quand rien n’est bloqué', () => {
    expect(phraseImagesBloquees([])).toBe('');
  });

  it('cite les domaines, et compte au-delà de trois', () => {
    expect(phraseImagesBloquees(['a.tld'])).toContain('préviendra a.tld que vous avez ouvert');
    expect(phraseImagesBloquees(['a.tld', 'b.tld', 'c.tld'])).toContain('a.tld, b.tld, c.tld');
    expect(phraseImagesBloquees(['a.tld', 'b.tld', 'c.tld', 'd.tld'])).toContain('et 1 autre ');
    expect(phraseImagesBloquees(['a.tld', 'b.tld', 'c.tld', 'd.tld', 'e.tld'])).toContain('et 2 autres ');
  });

  it('ce qui est nommé est exactement ce qui sera autorisé', () => {
    // L'invariant du consentement : demander l'autorisation pour des domaines, puis en
    // contacter d'autres, serait un consentement obtenu sur une fausse déclaration.
    const html = '<img src="https://a.tld/1.png"><img src="https://b.tld/2.png">';
    const { hotes, origines } = ressourcesDistantes(html);
    const phrase = phraseImagesBloquees(hotes);
    const csp = politiqueSecurite(origines);
    for (const h of hotes) {
      expect(phrase).toContain(h);
      expect(csp).toContain(h);
    }
    expect(csp).not.toContain('c.tld');
  });
});

describe('les verrous du cadre d’affichage', () => {
  it('N’ACCORDE JAMAIS allow-scripts', () => {
    // Associé à `allow-same-origin`, il rendrait au message le droit de s'exécuter DANS
    // notre origine : les deux ensemble annulent le bac à sable entier.
    expect(BAC_A_SABLE).not.toContain('allow-scripts');
    expect(BAC_A_SABLE).not.toContain('allow-top-navigation');
    expect(BAC_A_SABLE).not.toContain('allow-forms');
    // Présent pour une seule raison : mesurer la hauteur du document depuis la page hôte.
    expect(BAC_A_SABLE).toContain('allow-same-origin');
  });

  it('ne laisse sortir aucune requête tant que rien n’est autorisé', () => {
    const csp = politiqueSecurite([]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain('img-src data:;');
    // Aucune source distante nulle part : ni jeton générique, ni schéma réseau.
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('http');
  });

  it('après un oui, n’autorise QUE les origines nommées', () => {
    const csp = politiqueSecurite(['https://a.tld', 'http://b.tld:8080']);
    expect(csp).toContain('img-src data: https://a.tld http://b.tld:8080');
    expect(csp).toContain('font-src data: https://a.tld http://b.tld:8080');
    // Le relevé d'adresses n'est pas la barrière : ce qu'il rate reste bloqué, même
    // après le consentement, puisque l'autorisation est une liste fermée.
    expect(csp).not.toContain('https://c.tld');
    expect(csp).toContain("script-src 'none'");
  });
});

describe('le document remis au cadre', () => {
  it('retire ce qui ferait naviguer ou s’exécuter', () => {
    const html = '<html><body><script>alert(1)</script>'
      + '<meta http-equiv="refresh" content="0;url=https://pisteur.tld/vu">'
      + '<base href="https://pisteur.tld/">'
      + '<link rel="stylesheet" href="https://pisteur.tld/s.css">'
      + '<p>Bonjour</p></body></html>';
    const net = nettoyer(html);
    expect(net).not.toMatch(/<script/i);
    // Ni le bac à sable ni la politique de sécurité n'interdisent à un document de se
    // déplacer LUI-MÊME : c'est ce retrait qui l'en empêche.
    expect(net).not.toMatch(/<meta/i);
    expect(net).not.toMatch(/<base/i);
    expect(net).not.toMatch(/<link/i);
    expect(net).toContain('<p>Bonjour</p>');
  });

  it('garde l’image distante dans le document — c’est la politique qui la bloque', () => {
    // Ne PAS « corriger » en la supprimant : l'utilisateur doit pouvoir l'afficher d'un
    // clic sans qu'on recharge autre chose que le même document.
    const doc = documentCourriel('<img src="https://a.tld/1.png">');
    expect(doc).toContain('https://a.tld/1.png');
    expect(doc).toContain("img-src data:;");
  });

  it('porte la politique de sécurité et ouvre les liens hors du cadre', () => {
    const doc = documentCourriel('<p>x</p>', { origines: ['https://a.tld'] });
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain('img-src data: https://a.tld');
    expect(doc).toContain('<base target="_blank">');
  });
});

describe('lire un courrier qui n’a que du HTML', () => {
  it('en tire un texte lisible', () => {
    const html = '<style>p{color:red}</style><h1>Soldes</h1><p>Jusqu’à <b>-50 %</b></p><br><p>Merci</p>';
    expect(texteDepuisHtml(html)).toBe('Soldes\nJusqu’à -50 %\n\nMerci');
  });

  it('décode les entités, nommées comme numériques', () => {
    expect(texteDepuisHtml('<p>caf&eacute; &amp; th&#233; &#x263A;</p>')).toBe('café & thé ☺');
    // L'espace insécable des gabarits laisserait des lignes « vides » qui ne le sont pas.
    expect(texteDepuisHtml('<p>a&nbsp;&nbsp;b</p>')).toBe('a  b');
  });

  it('jette l’indentation du source', () => {
    // Gardée, elle décale les lignes d'une citation de réponse et fait passer un message
    // ordinaire pour du code.
    const html = `<table>
      <tr><td>
        <p>Bonjour,</p>
        <p>Merci.</p>
      </td></tr>
    </table>`;
    // Deux paragraphes restent séparés par une ligne vide ; c'est l'indentation, elle,
    // qui disparaît — aucune ligne ne commence par une espace.
    expect(texteDepuisHtml(html)).toBe(['Bonjour,', '', 'Merci.'].join('\n'));
  });

  it('ne laisse rien échapper des blocs muets', () => {
    expect(texteDepuisHtml('<script>var a = "secret";</script><p>ok</p>')).toBe('ok');
    expect(texteDepuisHtml('<head><title>Titre</title></head><p>ok</p>')).toBe('ok');
  });

  it('reconnaît un gabarit sans le moindre texte', () => {
    // Le cas ordinaire d'un envoi tout en images : c'est ce qui doit décider d'afficher
    // la visionneuse plutôt qu'une page blanche.
    expect(htmlEstVide('<table><tr><td><img src="https://a.tld/1.png"></td></tr></table>')).toBe(true);
    expect(htmlEstVide('<p>Bonjour</p>')).toBe(false);
    expect(htmlEstVide(null)).toBe(true);
  });
});
