const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

async function refresh() {
  const s = await send({ type: 'status' });
  if (s && s.connected) {
    $('connected').style.display = 'block';
    $('setup').style.display = 'none';
    $('email').textContent = s.email || '';
    $('enabled').checked = !!s.enabled;
  } else {
    $('connected').style.display = 'none';
    $('setup').style.display = 'block';
    if (s && s.server) $('server').value = s.server;
  }
}

$('connect').onclick = async () => {
  $('err').textContent = '';
  const server = $('server').value.trim();
  const code = $('code').value.trim();
  if (!server || !code) { $('err').textContent = 'Serveur et code requis.'; return; }
  const r = await send({ type: 'pair', server, code });
  if (r && r.ok) refresh(); else $('err').textContent = (r && r.error) || "Échec de l'appairage";
};
$('enabled').onchange = (e) => send({ type: 'setEnabled', enabled: e.target.checked });
$('disconnect').onclick = async () => { await send({ type: 'disconnect' }); refresh(); };

refresh();
