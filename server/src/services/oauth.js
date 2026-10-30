// OAuth2 pour les comptes mail externes (Gmail / Outlook) — flux « authorization code »
// avec jeton de rafraîchissement, puis authentification IMAP/SMTP en XOAUTH2.
// Les identifiants d'app (client id/secret) viennent de l'environnement ; sans eux,
// le fournisseur est simplement marqué « non configuré » et l'UI le signale.
import jwt from 'jsonwebtoken';
import { JWT_SECRET as SECRET } from '../config.js';

export const PROVIDERS = {
  gmail: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email openid',
    imapHost: 'imap.gmail.com', imapPort: 993,
    smtpHost: 'smtp.gmail.com', smtpPort: 465,
    clientId: () => process.env.COMET_GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.COMET_GOOGLE_CLIENT_SECRET,
    extraAuth: { access_type: 'offline', prompt: 'consent' }, // force un refresh_token
    email: async (accessToken) => {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
      if (!r.ok) throw new Error('userinfo Google échouée');
      return (await r.json()).email;
    },
  },
  outlook: {
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
    imapHost: 'outlook.office365.com', imapPort: 993,
    smtpHost: 'smtp.office365.com', smtpPort: 587,
    clientId: () => process.env.COMET_MS_CLIENT_ID,
    clientSecret: () => process.env.COMET_MS_CLIENT_SECRET,
    extraAuth: {},
    // PAS de fallback Graph : le jeton d'accès vise outlook.office.com, donc
    // graph.microsoft.com le REJETTE (jetons par ressource). On lit l'e-mail
    // dans l'id_token (cf. extractEmail) — le scope « openid email » le fournit.
  },
};

// Décode (sans vérifier la signature) le payload d'un JWT id_token.
export function decodeIdToken(idToken) {
  try {
    const part = String(idToken).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}

// Détermine l'adresse e-mail du compte connecté à partir de la réponse de jeton.
// 1) id_token (claim email/preferred_username) → aucun appel API, aucun souci d'audience.
// 2) repli éventuel propre au fournisseur (Google userinfo). Lève si rien d'exploitable.
export async function extractEmail(provider, tok) {
  if (tok && tok.id_token) {
    const c = decodeIdToken(tok.id_token);
    const e = c.email || c.preferred_username || c.upn;
    if (e && e.includes('@')) return e.toLowerCase();
  }
  const p = PROVIDERS[provider];
  if (p && p.email && tok && tok.access_token) {
    try { const e = await p.email(tok.access_token); if (e && e.includes('@')) return e.toLowerCase(); } catch { /* repli silencieux */ }
  }
  throw new Error("Adresse e-mail introuvable dans la réponse du fournisseur (id_token manquant ?)");
}

export const isOAuthProvider = (p) => Object.prototype.hasOwnProperty.call(PROVIDERS, p);
export function isConfigured(provider) {
  const p = PROVIDERS[provider];
  return !!(p && p.clientId() && p.clientSecret());
}
// Quels fournisseurs OAuth sont prêts à l'emploi (pour griser les boutons côté UI)
export function configuredProviders() {
  return Object.keys(PROVIDERS).filter(isConfigured);
}

// État signé (anti-CSRF) : porte l'utilisateur + le redirect_uri, valable 10 min.
export const signState = (payload) => jwt.sign(payload, SECRET, { expiresIn: '10m' });
export function verifyState(state) {
  try { return jwt.verify(state, SECRET); } catch { return null; }
}

export function buildAuthUrl(provider, { state, redirectUri }) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({
    client_id: p.clientId(), redirect_uri: redirectUri, response_type: 'code',
    scope: p.scope, state, ...p.extraAuth,
  });
  return `${p.authUrl}?${q.toString()}`;
}

async function tokenRequest(provider, params) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({ client_id: p.clientId(), client_secret: p.clientSecret(), ...params });
  const r = await fetch(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'échange de jeton refusé');
  return j; // { access_token, refresh_token?, expires_in }
}
export const exchangeCode = (provider, code, redirectUri) =>
  tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
export const refreshAccessToken = (provider, refreshToken) =>
  tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken });
