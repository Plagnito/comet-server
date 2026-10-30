#!/bin/sh
# Premier démarrage sans réglage : le secret qui signe les sessions est tiré au hasard
# et gardé dans le volume de données, pour survivre aux mises à jour de l'image.
# Un JWT_SECRET fourni par l'environnement reste prioritaire.
set -e
SECRET=/comet/server/data/.jwt_secret
if [ -z "$JWT_SECRET" ]; then
  if [ ! -s "$SECRET" ]; then
    node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))" > "$SECRET"
    chmod 600 "$SECRET"
    echo "Comet : secret de session créé dans le volume de données."
  fi
  JWT_SECRET="$(cat "$SECRET")"
  export JWT_SECRET
fi
exec node src/server.js
