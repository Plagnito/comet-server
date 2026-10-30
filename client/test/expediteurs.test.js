import { describe, it, expect } from 'vitest';
import {
  avecExpediteur, estExpediteurDeConfiance, normaliserExpediteur,
  politiqueSecurite, ressourcesDistantes, sansExpediteur,
} from '../src/mailhtml.js';

// « Toujours afficher les images de cet expéditeur » est un consentement DURABLE : il
// vaut pour des messages que le lecteur n'a pas encore vus. C'est exactement pour ça
// qu'il se teste — une comparaison d'adresses trop indulgente ouvrirait la porte à un
// expéditeur que personne n'a jamais autorisé, et rien à l'écran ne le montrerait.

describe('l’adresse d’un expéditeur', () => {
  it('se ramène à sa forme nue', () => {
    expect(normaliserExpediteur('lettre@gazette.fr')).toBe('lettre@gazette.fr');
    expect(normaliserExpediteur('  Lettre@Gazette.FR ')).toBe('lettre@gazette.fr');
    // Sans cette extraction, « La Gazette <lettre@gazette.fr> » et « lettre@gazette.fr »
    // seraient deux expéditeurs : le lecteur autoriserait l'un et serait redemandé pour
    // l'autre, sans comprendre pourquoi.
    expect(normaliserExpediteur('La Gazette <lettre@gazette.fr>')).toBe('lettre@gazette.fr');
  });

  it('refuse ce qui n’est pas une adresse', () => {
    // Une entrée sans arobase ne correspondrait jamais à rien — ou, mal comparée,
    // correspondrait à tout.
    expect(normaliserExpediteur('')).toBe(null);
    expect(normaliserExpediteur(null)).toBe(null);
    expect(normaliserExpediteur('La Gazette')).toBe(null);
    expect(normaliserExpediteur('a b@c.fr')).toBe(null);
  });
});

describe('la liste des expéditeurs toujours affichés', () => {
  const liste = ['lettre@gazette.fr', 'contact@asso.org'];

  it('reconnaît un expéditeur inscrit, quelle que soit sa casse', () => {
    expect(estExpediteurDeConfiance(liste, 'lettre@gazette.fr')).toBe(true);
    expect(estExpediteurDeConfiance(liste, 'La Gazette <LETTRE@Gazette.fr>')).toBe(true);
  });

  it('NE reconnaît PAS une adresse voisine', () => {
    // Le test qui compte. Une comparaison par suffixe ou par domaine ferait passer ces
    // trois-là pour l'expéditeur de confiance, et un message hostile chargerait ses
    // images — donc signalerait son ouverture — sans que rien ne s'affiche autrement.
    expect(estExpediteurDeConfiance(liste, 'lettre@fausse-gazette.fr')).toBe(false);
    expect(estExpediteurDeConfiance(liste, 'lettre@gazette.fr.attaquant.tld')).toBe(false);
    expect(estExpediteurDeConfiance(liste, 'autre@gazette.fr')).toBe(false);
  });

  it('ne fait confiance à personne par défaut', () => {
    expect(estExpediteurDeConfiance([], 'lettre@gazette.fr')).toBe(false);
    expect(estExpediteurDeConfiance(liste, '')).toBe(false);
    expect(estExpediteurDeConfiance(liste, null)).toBe(false);
    // Une adresse illisible ne doit jamais devenir un passe-partout.
    expect(estExpediteurDeConfiance(['pas-une-adresse'], 'pas-une-adresse')).toBe(false);
  });

  it('s’ajoute sans doublon et se retire', () => {
    expect(avecExpediteur([], 'La Gazette <Lettre@Gazette.fr>')).toEqual(['lettre@gazette.fr']);
    expect(avecExpediteur(liste, 'LETTRE@gazette.fr')).toEqual(liste);
    expect(avecExpediteur(liste, 'x@y.fr')).toEqual([...liste, 'x@y.fr']);
    expect(avecExpediteur(liste, 'pas-une-adresse')).toEqual(liste);
    expect(sansExpediteur(liste, 'Lettre@Gazette.fr')).toEqual(['contact@asso.org']);
    // Retirer doit VRAIMENT retirer : c'est la seule façon de revenir en arrière.
    expect(estExpediteurDeConfiance(sansExpediteur(liste, 'lettre@gazette.fr'), 'lettre@gazette.fr')).toBe(false);
  });

  it('n’ouvre pas le réseau : le oui reste borné aux origines DE CE message', () => {
    // Faire confiance à un expéditeur donne d'avance le « oui » du bandeau — pas un
    // blanc-seing. La politique de sécurité reste construite sur les seules adresses
    // trouvées dans le message affiché.
    const { origines } = ressourcesDistantes('<img src="https://cdn.gazette.fr/a.png">');
    const csp = politiqueSecurite(origines);
    expect(csp).toContain('img-src data: https://cdn.gazette.fr');
    expect(csp).not.toContain('pisteur');
    expect(csp).toContain("script-src 'none'");
  });
});
