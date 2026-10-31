// Conférence pair-à-pair (mesh WebRTC). Les flux audio/vidéo circulent directement
// entre participants ; le serveur ne sert que de relais de signaling (SDP/ICE).
// Modèle anti-collision : le nouvel arrivant initie les offres vers les pairs déjà présents.
// Serveurs STUN/TURN : ceux de l'instance (ice.js), jamais un service tiers écrit en dur.
import { chargerIce } from './ice.js';

export const VIDEO_CONSTRAINTS = {
  '1080p': { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { max: 30 } },
  '720p': { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { max: 30 } },
  '480p': { width: { ideal: 854, max: 854 }, height: { ideal: 480, max: 480 }, frameRate: { max: 24 } },
};
const AUDIO_CONSTRAINTS = {
  high: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  low: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
};
const mediaConstraints = (cfg) => ({
  video: VIDEO_CONSTRAINTS[cfg?.video] || VIDEO_CONSTRAINTS['720p'],
  audio: AUDIO_CONSTRAINTS[cfg?.audio] || AUDIO_CONSTRAINTS.high,
});

export class Conference {
  constructor(token, name, onEvent) {
    this.token = token;
    this.name = name || 'Invité';
    this.onEvent = onEvent;
    this.pcs = new Map();   // peerId -> RTCPeerConnection
    this.names = new Map(); // peerId -> displayName
    this.hosts = new Map(); // peerId -> isHost
    this.localStream = null;
    this.screenStream = null;
    this.room = null;
    this.you = null;
    this.isHost = false;
    this.config = { video: '720p', audio: 'high' };
    this.ws = null;
  }

  async start(room, config) {
    this.room = room;
    if (config) this.config = { ...this.config, ...config };
    this.localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints(this.config));
    this.onEvent({ type: 'local', stream: this.localStream });
    this.ice = await chargerIce(this.token);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Jeton dans le premier message, jamais dans l'adresse (journaux du tunnel, du proxy).
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this._onMsg(m); };
    this.ws.onopen = () => {
      this._send({ type: 'auth', token: this.token });
      this._send({ type: 'conf:join', room, name: this.name });
    };
    this.ws.onclose = () => this.onEvent({ type: 'closed' });
  }

  _send(o) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  _videoSender(pc) { return pc.getSenders().find((s) => s.track && s.track.kind === 'video'); }
  _activeVideoTrack() { return this.screenStream ? this.screenStream.getVideoTracks()[0] : this.localStream?.getVideoTracks()[0]; }

  _newPc(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this.ice || [] });
    for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);
    // Si un partage d'écran est en cours, le nouveau pair le reçoit aussi.
    if (this.screenStream) { const s = this._videoSender(pc); if (s) s.replaceTrack(this.screenStream.getVideoTracks()[0]); }
    pc.onicecandidate = (e) => { if (e.candidate) this._send({ type: 'conf:signal', room: this.room, to: peerId, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => this.onEvent({ type: 'peer', peerId, name: this.names.get(peerId), host: this.hosts.get(peerId), stream: e.streams[0] });
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._removePeer(peerId); };
    this.pcs.set(peerId, pc);
    return pc;
  }

  async _onMsg(m) {
    if (m.type === 'conf:peers') {
      this.you = m.you; this.isHost = !!m.isHost; if (m.config) this.config = { ...this.config, ...m.config };
      this.onEvent({ type: 'joined', you: m.you, isHost: this.isHost, config: this.config, count: m.peers.length });
      for (const peer of m.peers) {
        this.names.set(peer.peerId, peer.name); this.hosts.set(peer.peerId, !!peer.host);
        const pc = this._newPc(peer.peerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._send({ type: 'conf:signal', room: this.room, to: peer.peerId, data: { sdp: pc.localDescription } });
      }
    } else if (m.type === 'conf:peer-join') {
      this.names.set(m.peerId, m.name); this.hosts.set(m.peerId, !!m.host); // on attend l'offre du nouvel arrivant
    } else if (m.type === 'conf:peer-leave') {
      this._removePeer(m.peerId);
    } else if (m.type === 'conf:signal') {
      await this._onSignal(m.from, m.data);
    } else if (m.type === 'conf:config') {
      await this._applyConfig(m.config);
    } else if (m.type === 'conf:kicked') {
      this.onEvent({ type: 'kicked' });
    } else if (m.type === 'conf:error') {
      this.onEvent({ type: 'error', code: m.code });
    }
  }

  async _onSignal(from, data) {
    let pc = this.pcs.get(from);
    if (!pc) pc = this._newPc(from);
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        this._send({ type: 'conf:signal', room: this.room, to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch {}
    }
  }

  _removePeer(peerId) {
    const pc = this.pcs.get(peerId);
    if (pc) { try { pc.close(); } catch {} this.pcs.delete(peerId); }
    this.names.delete(peerId); this.hosts.delete(peerId);
    this.onEvent({ type: 'peerleave', peerId });
  }

  // Applique une nouvelle qualité (diffusée par l'hôte) : on ré-acquiert le flux et on remplace les pistes.
  async _applyConfig(config) {
    if (!config) return;
    const changed = config.video !== this.config.video || config.audio !== this.config.audio;
    this.config = { ...this.config, ...config };
    this.onEvent({ type: 'config', config: this.config });
    if (!changed || this.screenStream) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia(mediaConstraints(this.config));
      const oldAudio = this.localStream.getAudioTracks()[0];
      const wasMutedAudio = oldAudio ? !oldAudio.enabled : false;
      const oldVideo = this.localStream.getVideoTracks()[0];
      const wasOffVideo = oldVideo ? !oldVideo.enabled : false;
      const nv = fresh.getVideoTracks()[0]; const na = fresh.getAudioTracks()[0];
      if (nv) nv.enabled = !wasOffVideo; if (na) na.enabled = !wasMutedAudio;
      for (const pc of this.pcs.values()) {
        const vs = this._videoSender(pc); if (vs && nv) await vs.replaceTrack(nv);
        const as = pc.getSenders().find((s) => s.track && s.track.kind === 'audio'); if (as && na) await as.replaceTrack(na);
      }
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = fresh;
      this.onEvent({ type: 'local', stream: this.localStream });
    } catch {}
  }

  // Partage d'écran : remplace la piste vidéo envoyée à tous les pairs.
  async shareScreen() {
    const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = ds.getVideoTracks()[0];
    this.screenStream = ds;
    for (const pc of this.pcs.values()) { const s = this._videoSender(pc); if (s) await s.replaceTrack(track); }
    const local = new MediaStream([track, ...this.localStream.getAudioTracks()]);
    this.onEvent({ type: 'local', stream: local, screen: true });
    track.onended = () => this.stopScreen();
    return true;
  }
  async stopScreen() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop()); this.screenStream = null;
    const cam = this.localStream.getVideoTracks()[0];
    for (const pc of this.pcs.values()) { const s = this._videoSender(pc); if (s && cam) await s.replaceTrack(cam); }
    this.onEvent({ type: 'local', stream: this.localStream, screen: false });
  }

  kick(peerId) { this._send({ type: 'conf:kick', room: this.room, to: peerId }); }
  setRoomConfig(patch) { this._send({ type: 'conf:config', room: this.room, config: patch }); }

  toggleMute() { const t = this.localStream?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; return !t.enabled; } return false; }
  toggleCam() { const t = this.localStream?.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; return !t.enabled; } return false; }

  leave() {
    this._send({ type: 'conf:leave', room: this.room });
    for (const pc of this.pcs.values()) { try { pc.close(); } catch {} }
    this.pcs.clear(); this.names.clear(); this.hosts.clear();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.localStream?.getTracks().forEach((t) => t.stop());
    try { this.ws?.close(); } catch {}
  }
}
