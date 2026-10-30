import { describe, it, expect } from 'vitest';
import { apercu, texteDeHtml } from '../src/services/apercu.js';

describe('aperçu de liste', () => {
  it('préfère le texte quand il y en a un', () => {
    expect(apercu('Bonjour Léa', '<p>Autre chose</p>')).toBe('Bonjour Léa');
  });

  it('retombe sur le HTML quand le message n’a AUCUNE version texte', () => {
    // Le cas ordinaire d'un envoi commercial : `body` est vide, et la liste affichait
    // « Aucun aperçu » sur chaque ligne d'un courrier qui, lui, a bien un contenu.
    expect(apercu('', '<h1>Soldes</h1><p>Jusqu’à -50 %</p>')).toBe('Soldes Jusqu’à -50 %');
    expect(apercu(null, '<p>caf&eacute; &#38; th&eacute;</p>')).toBe('café & thé');
  });

  it('reste un EXTRAIT de 140 caractères', () => {
    // Un extrait est indiscernable d'un message court : c'est au client d'aller chercher
    // le corps entier avec `GET /api/mail/:id` à l'ouverture.
    const long = '<p>' + 'a'.repeat(400) + '</p>';
    expect(apercu('', long)).toHaveLength(140);
  });

  it('ne laisse pas fuir le contenu des blocs muets', () => {
    expect(texteDeHtml('<style>p{color:red}</style><script>var s=1</script><p>ok</p>')).toBe('ok');
  });

  it('rend une chaîne vide quand il n’y a rien', () => {
    expect(apercu('', null)).toBe('');
    expect(apercu(null, '<img src="https://a.tld/1.png">')).toBe('');
  });
});
