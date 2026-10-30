# Fédération Comet — protocole v1

Deux serveurs Comet échangent du courrier **directement**, sans service central. Le contenu
est chiffré de bout en bout par les clients ; les serveurs ne transportent que du chiffré.

## Adresses

Un serveur qui pose `COMET_DOMAINE=serveur-a.fr` rend son compte `camille@comet.mail`
joignable sous `camille@serveur-a.fr`. Sans `COMET_DOMAINE`, rien n'est publié ni accepté.
Un compte inscrit sous une autre adresse (`x@gmail.com`) n'a pas d'adresse fédérée.

Un correspondant distant est représenté localement par une ligne `users` marquée
`distant_domaine` : jamais de connexion possible, jamais dans l'annuaire.

## Identité d'un serveur

Clé Ed25519, créée au premier besoin, scellée en base avec le secret serveur.

```
GET https://serveur-b.fr/.well-known/comet
{
  "comet": 1,
  "domaine": "serveur-b.fr",
  "cle": "<SPKI DER base64>",
  "empreinte": "4F2A 91C0 …",            // SHA-256 de la clé, 8 groupes de 4 hexa
  "api": "https://serveur-b.fr/api/federation/v1",
  "rotation": null | { "ancienne": "<clé>", "date": "<ISO>", "signature": "<base64>" }
}
```

Le lecteur exige `domaine` = le domaine demandé et `api` sur la même origine que le document.

- **Premier contact** : la clé est mémorisée (`federation_pairs`, TOFU).
- **Rotation** : `rotation.signature` = signature par l'ANCIENNE clé de
  `comet-rotation-v1\n<domaine>\n<nouvelle clé>\n<date>`. Acceptée sans intervention si
  `ancienne` est la clé mémorisée.
- **Clé changée sans rotation valide** : le pair passe en `cle_changee`, tout est refusé
  jusqu'à ce que l'admin recopie l'empreinte de la nouvelle clé (comparée hors bande).

## Requêtes signées

| Point d'entrée | Rôle |
| --- | --- |
| `POST /api/federation/v1/cles` | `{ adresses: [...] }` → clés des comptes, chacune attestée |
| `POST /api/federation/v1/livraison` | dépôt d'un message chiffré |

En-têtes : `Comet-Emetteur`, `Comet-Date` (ISO 8601), `Comet-Nonce` (128 bits, base64url),
`Content-Digest: sha-256=:<base64>:` (corps brut), `Comet-Signature` (Ed25519, base64) sur :

```
comet-federation-v1
POST
<domaine destinataire>
/v1/livraison            (ou /v1/cles : chemin LOGIQUE, indépendant d'un préfixe de proxy)
<domaine émetteur>
<date>
<nonce>
<digest>
```

Contrôles du destinataire, dans cet ordre : limite par IP (300/min) → taille ≤ 1 Mio →
en-têtes → date à ±5 min → politique (mode, blocages) → empreinte du corps → signature
(clé mémorisée ; si elle échoue, relecture du document une fois) → nonce jamais vu (gardé
10 min, enregistré seulement après la signature) → débit par serveur (60/min par défaut).

Codes : `401` non signée / date / digest / signature, `403` bloqué / clé changée /
usurpation, `409` rejeu, `413` trop gros, `429` débit.

## Clés des comptes

Réponse de `/v1/cles` : `{ cles: { "<adresse>": null | { adresse, cle, date, nom, signature } } }`
où `signature` = signature par la clé du serveur de `comet-cle-v1\n<adresse>\n<clé RSA>\n<date>`.

Le serveur de l'expéditeur relaie cette attestation et la clé du serveur distant au client.
Le **client** vérifie l'attestation (WebCrypto Ed25519) et retient la clé du serveur
distant sur l'appareil : son propre serveur ne peut pas substituer la clé du destinataire
sans que l'appareil le voie (dès le deuxième contact, ou au numéro de sécurité).

## Livraison

```json
{
  "v": 1,
  "id": "comet:<uuid>@serveur-a.fr",
  "enReponseA": "comet:<uuid>@serveur-b.fr" | null,
  "de": { "adresse": "camille@serveur-a.fr", "nom": "Camille", "cle": "<clé RSA publique>" },
  "a": ["dominique@serveur-b.fr"], "cc": [],
  "envoyeLe": "<ISO>",
  "chiffre": { "ciphertext": "<AES-GCM base64>", "iv": "<base64>" },
  "cles": { "dominique@serveur-b.fr": "<clé AES enveloppée RSA-OAEP>" }
}
```

- `de.adresse` doit être du domaine de l'émetteur (un serveur ne parle que pour ses comptes),
  `id` doit finir par `@<émetteur>`.
- Seules les clés enveloppées pour les destinataires du serveur visé lui sont envoyées.
- `id` rend la relivraison sans effet et, avec `enReponseA`, garde le fil d'un serveur à l'autre.
- Réponse : `{ acceptes: [...], refuses: [{ adresse, raison }] }`.

L'expéditeur met en file (`federation_envois`), réessaie avec un délai croissant pendant
48 h, puis dépose un avis « Non remis » dans la boîte de l'expéditeur.

## Réseau

https seulement ; aucune redirection suivie ; réponse ≤ 256 Kio, 8 s. Une adresse privée ou
locale n'est jamais atteinte par découverte (anti-SSRF) : seulement par un hôte déclaré
(`COMET_FEDERATION_HOTES`), et c'est le seul cas où http est admis — vers une adresse privée.

## Numéro de sécurité

60 chiffres : pour chacun des deux correspondants, 30 chiffres tirés de SHA-512 itéré
5200 fois sur (version, clé publique, adresse fédérée) ; les deux moitiés sont rangées dans
l'ordre croissant. Les deux personnes voient le même numéro.

## Limites connues

- Métadonnées visibles des deux serveurs : qui écrit à qui, quand, taille.
- Premier contact : TLS + TOFU, tant que le numéro de sécurité n'est pas comparé.
- Pas de confidentialité persistante (clés RSA statiques des comptes).
- v1 : ni pièces jointes, ni envoi programmé, ni messages éphémères vers un autre serveur.
