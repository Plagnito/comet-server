# Comet — serveur auto-hébergé, en une image.
#   docker compose up -d        (voir docker-compose.yml)
# Étape 1 : l'interface web est compilée ici, puis seul son résultat est gardé.
FROM node:26-slim AS interface
WORKDIR /comet/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# Étape 2 : le serveur, ses dépendances de production, et l'interface compilée.
FROM node:26-slim
ENV NODE_ENV=production \
    PORT=4800 \
    HOST=0.0.0.0 \
    COMET_INSCRIPTION=ouverte
WORKDIR /comet/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./
COPY --from=interface /comet/client/dist /comet/client/dist
RUN chmod +x docker-entrypoint.sh && mkdir -p data && chown -R node:node /comet/server/data
USER node
# Tout ce qui doit survivre à une mise à jour de l'image : base, pièces jointes, secret.
VOLUME /comet/server/data
EXPOSE 4800
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4800/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
