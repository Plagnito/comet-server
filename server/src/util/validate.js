// Validation d'entrée déclarative (Zod) pour les routes sensibles.
// validateBody(schema) parse req.body ; en cas d'échec, renvoie une AppError typée
// (400 validation_error) au middleware d'erreurs central. En cas de succès, req.body
// est remplacé par les données validées/coercées.
import { z } from 'zod';
import { AppError } from './errors.js';

export const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.join('.') || 'corps';
    return next(new AppError(`Champ « ${where} » invalide : ${first?.message || 'valeur incorrecte'}`, { status: 400, code: 'validation_error' }));
  }
  req.body = result.data;
  next();
};

// ── Schémas partagés ─────────────────────────────────────────────────────────
// .passthrough() : on valide les champs sensibles sans supprimer les autres
// (ex. publicKey/encPrivateKey lus par le handler).
export const registerSchema = z.object({
  email: z.string().min(1, 'requis').max(160),
  displayName: z.string().max(80).optional(),
  password: z.string().min(1, 'requis').max(200),
  publicKey: z.string().max(8000).nullish(),
  bootstrapToken: z.string().max(256).optional(),
}).passthrough();

export const loginSchema = z.object({
  email: z.string().min(1, 'requis').max(160),
  password: z.string().min(1, 'requis').max(200),
}).passthrough();

export const mailAccountSchema = z.object({
  email: z.string().min(3, 'requis').max(160),
  username: z.string().max(160).optional(),
  password: z.string().min(1, 'requis').max(500),
  imapHost: z.string().min(1, 'requis').max(255),
  imapPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpHost: z.string().min(1, 'requis').max(255),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  label: z.string().max(60).optional(),
}).passthrough();
