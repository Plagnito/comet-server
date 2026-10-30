#!/usr/bin/env node
// Génère la paire de clés VAPID des NOTIFICATIONS BUREAU (Web Push).
//   node server/scripts/gen-vapid.js
//
// À lancer UNE fois. Colle les deux lignes affichées dans le .env du serveur :
// sans elles, le push reste INERTE et l'API le dit honnêtement (configured:false),
// plutôt que d'afficher un interrupteur qui ne ferait rien.
//
// ⚠️ La clé PRIVÉE ne doit jamais être versionnée ni servie au client. Seule la
// publique part vers le navigateur (elle sert à identifier l'expéditeur du push).
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('\n  Clés VAPID générées — à coller dans le .env du serveur Comet :\n');
console.log('COMET_VAPID_PUBLIC=' + publicKey);
console.log('COMET_VAPID_PRIVATE=' + privateKey);
console.log('COMET_PUSH_SUBJECT=mailto:support@comet.mail');
console.log('\n  ⚠️ Garde la clé privée hors du dépôt. Change-la = tous les abonnements existants deviennent muets.\n');
