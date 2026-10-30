// Exécuté AVANT l'import de l'app dans chaque fichier de test : fixe un
// environnement de test isolé. dotenv (chargé par server.js) n'écrase pas les
// variables déjà définies → ces valeurs priment sur server/.env.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
// Secret de test : ≥ 32 caractères et hors liste interdite (cf. config.js).
process.env.JWT_SECRET = 'test-secret-pour-vitest-0123456789abcdef';
// Comptes de démo (lea/marc/sophie) : désactivés en production (chacun arrive sans
// org), mais REQUIS par la suite de tests d'intégration → réactivés ici uniquement.
process.env.COMET_SEED_DEMO = '1';
// Base SQLite jetable, recréée et seedée (lea/marc/sophie) à l'import de db.js.
const dbPath = join(tmpdir(), 'comet-vitest.db');
process.env.COMET_DB_PATH = dbPath;
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(dbPath + suffix, { force: true }); } catch { /* absent */ }
}
