// Erreurs applicatives typées + handler centralisé.
// AppError porte un statut HTTP et un code machine ; son message est considéré
// « sûr » (destiné au client). Toute autre exception est journalisée côté serveur
// et renvoyée en 500 générique (aucune fuite d'interne : stack, SQL, upstream…).

export class AppError extends Error {
  constructor(message, { status = 400, code = 'bad_request' } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = true; // message sûr à exposer au client
  }
}

// Raccourcis fréquents.
export const badRequest = (msg = 'Requête invalide', code = 'bad_request') => new AppError(msg, { status: 400, code });
export const unauthorized = (msg = 'Authentification requise', code = 'unauthorized') => new AppError(msg, { status: 401, code });
export const forbidden = (msg = 'Accès refusé', code = 'forbidden') => new AppError(msg, { status: 403, code });
export const notFound = (msg = 'Introuvable', code = 'not_found') => new AppError(msg, { status: 404, code });

// Enveloppe un handler async pour router ses rejets vers next() (Express 4 ne
// capture pas les promesses rejetées automatiquement).
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Middleware d'erreurs final. À monter en dernier.
export function errorHandler(err, req, res, _next) {
  // Rejet CORS : routine, 403 sans stack.
  if (err && err.message === 'Origine non autorisée par CORS') {
    return res.status(403).json({ error: 'Origine non autorisée', code: 'cors_forbidden' });
  }
  // Erreur applicative typée : message sûr + code.
  if (err instanceof AppError || err?.expose) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code || 'error' });
  }
  // Inconnue : on journalise tout, on ne révèle rien.
  console.error('[error]', err);
  res.status(500).json({ error: 'Erreur serveur', code: 'internal_error' });
}
