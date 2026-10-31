import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { requestHost } from './util/proxy.js';

const nonce = (_req, res) => `'nonce-${res.locals.scriptNonce}'`;
const websocketOrigin = (req) => {
  try {
    const url = new URL(process.env.COMET_BASE_URL || `${req.protocol}://${requestHost(req)}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.origin;
  } catch { return "'self'"; }
};

export function securityHeaders() {
  return [
    (_req, res, next) => { res.locals.scriptNonce = randomBytes(18).toString('base64'); next(); },
    helmet({
      contentSecurityPolicy: { directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [nonce, "'strict-dynamic'", "'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Le courrier isolé applique sa propre politique d'images/consentement.
        imgSrc: ["'self'", 'data:', 'blob:', 'http:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", websocketOrigin],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"],
        // Ne pas transformer les URL HTTP loopback de l'édition auto-hébergée.
        upgradeInsecureRequests: null,
      } },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  ];
}

// Chaque script reçoit le nonce de la réponse. data-cfasync="false" demande en plus à
// Cloudflare Rocket Loader de ne pas le réécrire : sinon il change son type et confie
// l'exécution à son propre script, que cette politique bloque (aucun nonce), et la page
// (une fenêtre de connexion, par exemple) ne fait plus rien.
export const nonceScripts = (html, value) => html
  .replace(/<script\b(?![^>]*\bdata-cfasync=)/gi, '<script data-cfasync="false"')
  .replace(/<script\b/gi, `<script nonce="${value}"`);
