import { defineConfig } from 'vitest/config';

// Tests d'intégration : on importe l'app Express (sans ouvrir de port ni de
// planificateurs grâce au garde isMain de server.js) et on tape dessus via
// supertest. Un seul worker + une base temporaire isolée (cf. test/setup.js).
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    // Un seul worker + pas de parallélisme : app et base SQLite partagées,
    // exécution séquentielle (les tests de rate-limit doivent rester en dernier).
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // Les tests tournent sur un runner auto-hébergé qui partage le PC avec la
    // construction de l'app de bureau, lancée par le même push : un test qui prend 1 s
    // au repos en a pris 8. Les 5 s par défaut faisaient rougir la suite au hasard ;
    // 20 s laissent la marge sans masquer un vrai blocage.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // La règle qui décide ce qu'un courrier venu du dehors a le droit d'aller chercher
    // sur le réseau vit dans le client (`client/src/mailhtml.js`), et elle DOIT être
    // testée : un pixel espion est invisible à l'œil, sa panne ne se verrait jamais à
    // l'usage. Le client n'a pas de lanceur de tests à lui — la suite du dépôt s'en
    // charge. Ces fichiers-là sont du JavaScript pur : ni DOM, ni React.
    include: ['test/**/*.test.js', '../client/test/**/*.test.js'],
  },
});
