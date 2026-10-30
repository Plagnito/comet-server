# Comet — serveur auto-hébergeable

Comet est une suite de productivité **chiffrée de bout en bout** que vous installez
sur votre propre serveur : courrier, messagerie d'équipe, conférence, calendrier,
contacts, tâches, tableau, pipelines, notes et coffre-fort. Vos comptes, vos données et
vos clés restent chez vous.

On l'utilise depuis un navigateur, ou depuis l'application de bureau (Windows, macOS,
Linux), qui se connecte au serveur de votre choix.

---

## Installer un serveur

### Avec Docker (le plus simple)

Il faut une machine allumée en permanence (un PC, un Raspberry Pi, un petit serveur
loué) avec [Docker](https://docs.docker.com/get-docker/).

```bash
git clone https://github.com/Plagnito/comet-server.git
cd comet-server
docker compose up -d
```

Ouvrez **http://adresse-de-la-machine:4800** et créez votre compte. **Le premier compte
créé devient administrateur.** C'est tout : la base de données, les pièces jointes et le
secret de session sont créés au premier démarrage et rangés dans un volume Docker, qui
survit aux mises à jour.

Une fois vos comptes créés, fermez les inscriptions dans `docker-compose.yml`
(`COMET_INSCRIPTION: fermee`), puis `docker compose up -d`.

Mettre à jour :

```bash
git pull && docker compose up -d --build
```

### Rendre le serveur joignable depuis Internet

Le serveur écoute en HTTP sur le port 4800. Pour s'y connecter de partout, il lui faut
une adresse en **HTTPS**. Deux façons courantes :

- **Tunnel Cloudflare** (aucun port à ouvrir sur votre box) : avec un nom de domaine
  géré par Cloudflare, `cloudflared tunnel` relie `https://comet.mon-domaine.fr` à
  `http://localhost:4800`.
- **Relais inverse** (Caddy, nginx) devant le port 4800, qui obtient le certificat
  HTTPS tout seul (Caddy : une ligne, `comet.mon-domaine.fr { reverse_proxy localhost:4800 }`).

Renseignez ensuite cette adresse dans `COMET_BASE_URL` (liens de partage, pièces jointes
volumineuses, connexion Gmail/Outlook).

### Sans Docker

Il faut **Node.js 25 ou plus récent** (Comet utilise la base SQLite intégrée à Node).

```bash
cd client && npm ci && npm run build && cd ..
cd server && npm ci --omit=dev
cp .env.example .env      # puis renseignez au moins JWT_SECRET
npm start
```

---

## L'application de bureau

Au premier lancement, elle demande l'adresse de votre serveur, vérifie qu'il s'agit bien
d'un serveur Comet, puis la retient. On en change dans **Paramètres → Serveur**. Le HTTPS
est exigé, sauf sur le réseau local.

Pour l'instant, l'application se compile depuis ce dépôt : `npm install` à la racine,
puis `npm run dist` (installateurs dans `release/`).

---

## Ce qui est chiffré, et ce qui ne l'est pas

- Les messages échangés **entre comptes d'un même serveur** sont chiffrés de bout en bout :
  le serveur stocke du contenu qu'il ne peut pas lire.
- Votre **mot de passe est aussi votre clé de chiffrement**. S'il est perdu, le courrier
  chiffré l'est avec lui : aucun administrateur ne peut le récupérer. C'est le prix d'un
  serveur qui ne peut pas lire ce qu'il garde.
- Le courrier venu de l'extérieur (un compte Gmail ou Outlook relié à Comet) arrive en
  clair du réseau, comme partout ailleurs. Comet le signale sur chaque message concerné.
- Les fichiers de plus de 50 Mo sont transmis **non chiffrés** (hébergés par le serveur et
  partagés en torrent web-seed). L'interface prévient avant l'envoi.

## Ce que cette édition ne fait pas encore

- **Les outils d'organisation** (annuaire d'entreprise, projets, objectifs, suivi du temps,
  rapports) supposent une gestion des organisations qui n'existe pas encore ici : ils sont
  masqués.
- **Deux serveurs Comet ne communiquent pas encore entre eux.** Un compte écrit aux autres
  comptes de son serveur, et au reste du monde via un compte mail relié (Gmail, Outlook,
  IMAP/SMTP). La fédération entre serveurs, chiffrée et sans intermédiaire, est la
  prochaine étape.
- **Mot de passe oublié** : pas de réinitialisation (voir plus haut).

---

## Configuration

Tout est décrit dans [`server/.env.example`](server/.env.example) : inscriptions, adresse
publique, comptes Gmail/Outlook en un clic, serveur TURN pour la visio à travers Internet,
notifications bureau. Rien n'est obligatoire avec Docker.

## Développement

```bash
npm run install:all   # dépendances racine, serveur et client
npm run dev           # serveur (4800) + interface Vite (5174)
cd server && npm test
```

Serveur : Node.js, Express, `node:sqlite`. Interface : React 18 et Vite. Bureau : Electron.

## Licence

Comet est publié sous **GNU AGPL v3** (voir [`LICENSE`](LICENSE)). Vous pouvez l'utiliser,
le modifier et l'héberger librement ; si vous proposez une version modifiée à d'autres
personnes à travers un réseau, vous devez leur en donner le code source.

Créé par Plagnito.
