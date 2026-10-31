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
2. **Télécharger le connecteur** (`comet-connector.mjs`), puis **créer une clé** en cochant
   ses droits (copiez-la : elle n'est affichée qu'une fois).
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

## Droits d'une clé

Chaque clé n'ouvre que ce que l'administrateur a coché ; donnez à chaque connecteur la plus
petite liste possible.

| Droit | Ce qu'il permet |
|-------|-----------------|
| `export` | Archiver l'instance. **L'export contient tout**, y compris ce qui n'est pas chiffré de bout en bout (notes, contacts, agenda, tâches) : gardez cette clé et les archives à l'abri. |
| `visio` | Annoncer les salons de visio prévus à l'agenda. |
| `ia` | Traiter les questions de l'assistant IA (avec `--ai-url`). |

Une tâche dont la clé n'a pas le droit est sautée (le connecteur le signale une fois) ; les
autres continuent. Une clé peut expirer à une date choisie. Chaque appel est journalisé :
l'administrateur voit dans l'application quelle clé a servi, quand, et pour quoi.
