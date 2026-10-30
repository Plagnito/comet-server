export function requestHost(req) {
  const trusted = req.app.get('trust proxy fn')(req.socket.remoteAddress, 0);
  return String((trusted && req.get('x-forwarded-host')) || req.get('host') || '').split(',')[0].trim().toLowerCase();
}
