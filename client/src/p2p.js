// Transfert de pièces jointes en pair-à-pair (WebRTC DataChannel).
// Le fichier ne touche jamais le serveur ; il est chiffré (AES-GCM) avec une clé
// transportée dans le message E2EE → ni le serveur ni le canal de signaling ne lisent rien.
const subtle = globalThis.crypto.subtle;

const b64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const ub64 = (str) => { const bin = atob(str); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };

export const newTransferId = () => crypto.randomUUID();
export const newFileKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));

const importKey = (keyB64) => subtle.importKey('raw', ub64(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function aesEncrypt(buf, keyB64, iv) { return subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(keyB64), buf); }
async function aesDecrypt(buf, keyB64, ivB64) { return subtle.decrypt({ name: 'AES-GCM', iv: ub64(ivB64) }, await importKey(keyB64), buf); }

// Chiffre une seule fois → le même ciphertext sert au P2P ET au repli serveur.
export async function encryptAttachment(buf, keyB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aesEncrypt(buf, keyB64, iv);
  return { ct, ivB64: b64(iv) };
}
export const decryptAttachment = (ct, ivB64, keyB64) => aesDecrypt(ct, keyB64, ivB64);

let sendSignal = () => {};
let rtcConfig = { iceServers: [] };
const offers = new Map();    // transferId -> { buf:ArrayBuffer, keyB64 }
const transfers = new Map(); // transferId -> état de connexion

export async function initP2P(send) {
  sendSignal = send;
  try { rtcConfig = await fetch('/api/rtc-config').then((r) => r.json()); } catch {}
}

// ── Côté émetteur : met un fichier (déjà chiffré) à disposition tant que l'app est ouverte ──
export function offerFile(transferId, ct, ivB64) { offers.set(transferId, { ct, ivB64 }); }
export function clearOffers() { offers.clear(); }

const CHUNK = 16 * 1024;
async function streamFile(channel, offer) {
  const view = new Uint8Array(offer.ct);
  channel.send(JSON.stringify({ t: 'meta', size: view.length, iv: offer.ivB64 }));
  channel.bufferedAmountLowThreshold = CHUNK * 8;
  for (let o = 0; o < view.length; o += CHUNK) {
    if (channel.bufferedAmount > CHUNK * 64) {
      await new Promise((res) => { channel.onbufferedamountlow = res; });
    }
    channel.send(view.subarray(o, o + CHUNK));
  }
  channel.send(JSON.stringify({ t: 'end' }));
}

// ── Côté récepteur : demande et reçoit le fichier ────────────────────────────
export function requestFile(transferId, fromUserId, keyB64, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection(rtcConfig);
    const channel = pc.createDataChannel('file');
    channel.binaryType = 'arraybuffer';
    const chunks = [];
    let received = 0, total = 0, meta = null;
    const t = { pc, channel, peer: fromUserId, reject };
    transfers.set(transferId, t);

    const fail = (e) => { cleanup(transferId); reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('Expéditeur injoignable (hors ligne ?)')), 20000);

    pc.onicecandidate = (e) => { if (e.candidate) sendSignal(fromUserId, { kind: 'ice', transferId, candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(pc.connectionState)) fail(new Error('Connexion P2P perdue')); };

    channel.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.t === 'meta') { meta = m; total = m.size; }
        else if (m.t === 'unavailable') { clearTimeout(timer); fail(new Error('Fichier non disponible chez l’expéditeur')); }
        else if (m.t === 'end') {
          clearTimeout(timer);
          try {
            const enc = new Uint8Array(total); let p = 0;
            for (const c of chunks) { enc.set(c, p); p += c.length; }
            const plain = await aesDecrypt(enc.buffer, keyB64, meta.iv);
            cleanup(transferId);
            resolve(new Uint8Array(plain));
          } catch (err) { fail(err); }
        }
      } else {
        chunks.push(new Uint8Array(e.data));
        received += e.data.byteLength;
        onProgress?.(received, total);
      }
    };

    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => sendSignal(fromUserId, { kind: 'offer', transferId, sdp: pc.localDescription }))
      .catch(fail);
  });
}

function cleanup(transferId) {
  const t = transfers.get(transferId);
  if (t) { try { t.channel?.close(); } catch {} try { t.pc?.close(); } catch {} transfers.delete(transferId); }
}

// ── Routage des signaux WebRTC reçus via WebSocket ───────────────────────────
export async function onSignal(from, data) {
  if (!data || !data.transferId) return;
  const { transferId, kind } = data;

  if (kind === 'offer') {
    // On est l'émetteur : un pair demande un fichier qu'on propose
    const offer = offers.get(transferId);
    if (!offer) { sendSignal(from, { kind: 'unavailable', transferId }); return; }
    const pc = new RTCPeerConnection(rtcConfig);
    transfers.set(transferId, { pc, peer: from });
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal(from, { kind: 'ice', transferId, candidate: e.candidate }); };
    pc.ondatachannel = (e) => {
      const ch = e.channel; ch.binaryType = 'arraybuffer';
      ch.onopen = () => streamFile(ch, offer).catch(() => { try { ch.send(JSON.stringify({ t: 'unavailable' })); } catch {} });
      ch.onclose = () => cleanup(transferId);
    };
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal(from, { kind: 'answer', transferId, sdp: pc.localDescription });
  } else if (kind === 'answer') {
    const t = transfers.get(transferId);
    if (t) await t.pc.setRemoteDescription(data.sdp);
  } else if (kind === 'ice') {
    const t = transfers.get(transferId);
    if (t) { try { await t.pc.addIceCandidate(data.candidate); } catch {} }
  } else if (kind === 'unavailable') {
    transfers.get(transferId)?.reject?.(new Error('Fichier non disponible'));
    cleanup(transferId);
  }
}
