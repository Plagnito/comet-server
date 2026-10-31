// Règles de sécurité de l'application de bureau (desktop/securite.cjs) : origine
// exacte, schémas confiés au système, expéditeurs IPC. Fonctions pures, sans Electron.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { origineDe, origineParmi, sousChemin, lienExterneAutorise, memeFichier, expediteurAutorise } = require('../../desktop/securite.cjs');

const SERVEUR = 'https://comet.exemple.fr';
const LOCAL = 'http://localhost:4800';
const PAGE_CHOIX = 'file:///C:/Program%20Files/Comet/resources/app.asar/desktop/choisir-serveur.html';
const CANAUX_CHOIX = ['serveur:get', 'serveur:tester', 'serveur:utiliser', 'window:close'];

describe('origine exacte', () => {
  it('reconnaît le serveur et ses pages', () => {
    expect(origineParmi(`${SERVEUR}/`, [SERVEUR])).toBe(true);
    expect(origineParmi(`${SERVEUR}/api/accounts/oauth/gmail/start?x=1`, [SERVEUR])).toBe(true);
    expect(origineParmi('https://COMET.exemple.fr:443/a', [SERVEUR])).toBe(true);
  });

  it('refuse ce qui ne fait que commencer pareil', () => {
    for (const piege of [
      'https://comet.exemple.fr.pirate.net/',
      'https://comet.exemple.fr@pirate.net/',
      'https://comet.exemple.fr:8443/',
      'http://comet.exemple.fr/',
      'https://comet.exemple.frx/',
    ]) expect(origineParmi(piege, [SERVEUR]), piege).toBe(false);
    expect(origineParmi('http://localhost:4800.pirate.net/', [LOCAL])).toBe(false);
    expect(origineParmi('http://localhost:48000/', [LOCAL])).toBe(false);
  });

  it('ignore les origines vides et les adresses sans origine', () => {
    expect(origineParmi(`${SERVEUR}/`, ['', null, undefined])).toBe(false);
    expect(origineParmi('about:blank', [SERVEUR])).toBe(false);
    expect(origineParmi('data:text/html,<p>', [SERVEUR])).toBe(false);
    expect(origineParmi(PAGE_CHOIX, [SERVEUR])).toBe(false);
    expect(origineDe('pas une adresse')).toBe(null);
  });

  it('sous-chemin : même origine et préfixe de chemin', () => {
    const base = 'https://identite.exemple.org';
    expect(sousChemin('https://identite.exemple.org/api/connexion/authorize?x', base, '/api/connexion/')).toBe(true);
    expect(sousChemin('https://identite.exemple.org.pirate.net/api/connexion/authorize', base, '/api/connexion/')).toBe(false);
    expect(sousChemin('https://identite.exemple.org/api/connexion-faux/x', base, '/api/connexion/')).toBe(false);
    expect(sousChemin('http://identite.exemple.org/api/connexion/authorize', base, '/api/connexion/')).toBe(false);
  });
});

describe('liens confiés au système', () => {
  it('accepte https, http et mailto', () => {
    expect(lienExterneAutorise('https://exemple.org/page')).toBe(true);
    expect(lienExterneAutorise('http://exemple.org/')).toBe(true);
    expect(lienExterneAutorise('mailto:quelqu.un@exemple.org?subject=Bonjour')).toBe(true);
  });

  it('refuse les schémas qui lancent un programme ou lisent le disque', () => {
    for (const lien of [
      'file:///C:/Windows/System32/calc.exe',
      '\\\\serveur\\partage\\outil.exe',
      'smb://serveur/partage',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x',
      'javascript:alert(1)',
      'vbscript:msgbox',
      'data:text/html,<script>',
      'steam://run/1',
      'zoommtg://zoom.us/join',
      '',
      'pas une adresse',
    ]) expect(lienExterneAutorise(lien), lien).toBe(false);
  });

  it('refuse une adresse web qui porte un identifiant avant l’hôte', () => {
    expect(lienExterneAutorise('https://banque.fr@pirate.net/')).toBe(false);
    expect(lienExterneAutorise('https://a:b@exemple.org/')).toBe(false);
  });
});

describe('expéditeurs IPC', () => {
  const avis = (adresse, canal) => expediteurAutorise({ adresse, origines: [SERVEUR, ''], pageChoix: PAGE_CHOIX, canal, canauxChoix: CANAUX_CHOIX });

  it('le serveur Comet chargé a droit à tous les canaux', () => {
    expect(avis(`${SERVEUR}/`, 'torrent:download')).toBe(true);
    expect(avis(`${SERVEUR}/rejoindre/abc`, 'dl:choose')).toBe(true);
  });

  it('la page de choix du serveur n’a droit qu’à ses canaux', () => {
    expect(avis(PAGE_CHOIX, 'serveur:utiliser')).toBe(true);
    expect(avis('file:///c:/Program Files/Comet/resources/app.asar/desktop/choisir-serveur.html', 'serveur:get')).toBe(true);
    expect(avis(PAGE_CHOIX, 'torrent:download')).toBe(false);
    expect(avis(PAGE_CHOIX, 'autostart:set')).toBe(false);
  });

  it('refuse toute autre page, même chargée dans une fenêtre de l’app', () => {
    for (const adresse of [
      'https://identite.exemple.org/api/connexion/authorize',
      'https://comet.exemple.fr.pirate.net/',
      'https://accounts.google.com/o/oauth2/auth',
      'file:///C:/Users/x/Downloads/piege.html',
      'about:blank',
      '',
    ]) expect(avis(adresse, 'serveur:get'), adresse).toBe(false);
  });

  it('le serveur local n’est de confiance que s’il est chargé', () => {
    expect(expediteurAutorise({ adresse: `${LOCAL}/`, origines: [SERVEUR, ''], pageChoix: PAGE_CHOIX, canal: 'dl:get', canauxChoix: CANAUX_CHOIX })).toBe(false);
    expect(expediteurAutorise({ adresse: `${LOCAL}/`, origines: [SERVEUR, LOCAL], pageChoix: PAGE_CHOIX, canal: 'dl:get', canauxChoix: CANAUX_CHOIX })).toBe(true);
  });

  it('memeFichier compare le chemin, pas un préfixe', () => {
    expect(memeFichier(`${PAGE_CHOIX}#x`, PAGE_CHOIX)).toBe(true);
    expect(memeFichier(PAGE_CHOIX.replace('.html', '.html.evil'), PAGE_CHOIX)).toBe(false);
    expect(memeFichier('https://comet.exemple.fr/desktop/choisir-serveur.html', PAGE_CHOIX)).toBe(false);
  });
});
