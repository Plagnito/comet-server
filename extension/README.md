# Comet — Extension navigateur

Enregistre automatiquement vos identifiants dans le **coffre-fort chiffré** de Comet.

## Confidentialité (zéro-knowledge)

L'extension chiffre chaque identifiant capturé **vers votre clé publique** (RSA-OAEP, même
format que Comet) avant de l'envoyer. Le serveur ne stocke que du chiffré et se contente de
copier les entrées dans votre coffre — il ne peut jamais lire vos mots de passe. Seule votre
clé privée (déverrouillée par votre mot de passe dans l'application) peut les déchiffrer.

## Installation

1. Dans Comet : **Paramètres → Options avancées → Extension navigateur**.
2. **Télécharger l'extension** (`comet-extension.zip`) et la décompresser.
3. Navigateur → `chrome://extensions` (ou `edge://extensions`) → activer le **mode développeur**
   → **Charger l'extension non empaquetée** → sélectionner le dossier décompressé.
4. Dans Comet, cliquer **Générer un code d'appairage**.
5. Ouvrir l'extension (icône de la barre d'outils), saisir l'adresse du serveur et le code.

Désormais, à chaque connexion sur un site, l'identifiant est capturé, chiffré et envoyé.
**Ouvrez le coffre-fort de Comet** pour importer les mots de passe capturés.

## Fichiers

- `manifest.json` — manifeste MV3.
- `background.js` — service worker : chiffrement + envoi, appairage.
- `content.js` — détection des formulaires de connexion.
- `popup.html` / `popup.js` — configuration et état.
