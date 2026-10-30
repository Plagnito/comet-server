# Comet Connecteur

Agent autonome d'organisation pour Comet. À installer sur un serveur de l'organisation.

## Ce qu'il fait

1. **Archive toutes les données** — snapshots horodatés (`comet-archive/`). Les messages et le
   chat sont chiffrés de bout en bout : l'archive ne contient que du chiffré (sauvegarde « aveugle »).
2. **Crée automatiquement les salons de conférence** des événements marqués « salle de conférence »
   à l'agenda, et prévient les participants.
3. **Prépare l'espace de stockage partagé** selon la configuration définie dans l'application.

## Installation

1. Dans Comet : **Paramètres → Options avancées → Connecteur d'organisation**.
2. **Télécharger le connecteur** (`comet-connector.mjs`) et **Générer une clé de connexion** (copiez-la).
3. Sur le serveur (Node 18+) :

```bash
node comet-connector.mjs --server https://comet.votre-domaine.fr --key cmtk_votreCle
```

## Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `--server` | `http://localhost:4800` | URL du serveur Comet |
| `--key` | — | Clé de connecteur (**requis**) |
| `--archive` | `./comet-archive` | Dossier des archives |
| `--interval` | `60` | Secondes entre deux passages |
| `--once` | — | Un seul passage puis quitter |

La clé peut aussi être fournie via la variable d'environnement `COMET_CONNECTOR_KEY`.
Révoquez-la à tout moment depuis l'application.
