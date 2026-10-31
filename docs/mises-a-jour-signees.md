# Mises à jour signées de l'application de bureau

L'application de bureau se met à jour toute seule en demandant les fichiers au serveur
Comet qu'elle utilise. Ce serveur n'est qu'un relais : l'application n'installe un
fichier que si sa **signature Ed25519** correspond à la clé publique qu'elle embarque,
`desktop/cle-mises-a-jour.pem`. Un serveur compromis, ou mal choisi, ne peut donc pas
faire installer autre chose que ce que la construction a signé.

## Ce qui est signé

Pour chaque installateur : un en-tête fixe, la **version**, la **plateforme** (`win32`,
`linux`) et l'**empreinte SHA-512** du fichier. L'application recalcule l'empreinte sur
le fichier téléchargé, et refuse :

- un fichier sans signature, ou dont la signature ne correspond pas ;
- un installateur authentique annoncé sous une autre version ou servi à une autre
  plateforme ;
- une version égale ou antérieure à celle installée, même authentique (pas de retour
  vers une version vulnérable).

Un fichier refusé est effacé et n'est jamais installé. La vérification est dans
`desktop/maj-signee.cjs`, testée par `server/test/maj-signee.test.js`.

macOS : seul un `.dmg` est construit, sans archive de mise à jour ; l'application macOS
ne se met pas à jour toute seule.

## Signer une construction

La signature s'ajoute aux fichiers de canal produits par electron-builder
(`latest.yml`, `latest-linux.yml`) sous la forme d'une ligne `cometSignature: …` :

```bash
node scripts/signer-mises-a-jour.mjs release --cle chemin/vers/cle-privee.pem
```

ou avec la clé dans la variable `COMET_UPDATE_SIGNING_KEY` (contenu PEM), comme le fait
la construction automatique. Le script revérifie chaque signature avec la clé publique
de l'application et s'arrête si la clé secrète ne lui correspond pas.

## Distribuer sa propre application

Si vous construisez et distribuez vos propres installateurs, générez votre paire de
clés et remplacez `desktop/cle-mises-a-jour.pem` par votre clé publique :

```bash
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');console.log(k.privateKey.export({type:'pkcs8',format:'pem'}));console.log(k.publicKey.export({type:'spki',format:'pem'}))"
```

Gardez la clé privée hors du dépôt, et sauvegardez-la : sans elle, plus aucune mise à
jour ne sera acceptée par les applications déjà installées, qui devront être
réinstallées à la main.

## Limite

Une application installée avant l'arrivée de cette vérification fait sa prochaine mise
à jour avec l'ancien code, qui ne vérifie rien. Les mises à jour suivantes sont
vérifiées.
