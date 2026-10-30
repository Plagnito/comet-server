// Échappement HTML pour toute donnée réfléchie dans une page servie par le serveur
// (pages de callback OAuth). Empêche le XSS réfléchi via les paramètres de requête
// et les messages d'erreur des fournisseurs.
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
