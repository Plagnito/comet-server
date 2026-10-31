// Comptes mail extérieurs : le serveur ne se connecte pas, à la demande d'un
// utilisateur, à une adresse locale ou privée ni à un port qui n'est pas un port mail.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { estAdressePrivee } from '../src/util/adresses.js';
import { destinationMail, DestinationRefusee } from '../src/services/mail-destination.js';

describe('Classement des adresses', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '0:0:0:0:0:ffff:7f00:0001',
    '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::1', '2002:c0a8:101::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1',
  ])('%s est locale ou privée', (ip) => expect(estAdressePrivee(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2a00:1450:4007:80e::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    '%s est publique', (ip) => expect(estAdressePrivee(ip)).toBe(false));
});

describe('Destination d’un serveur mail', () => {
  afterEach(() => { delete process.env.COMET_MAIL_RESEAU_LOCAL; delete process.env.COMET_MAIL_PORTS_LIBRES; });

  it('refuse la boucle locale, sous toutes ses écritures', async () => {
    for (const h of ['127.0.0.1', 'localhost', '[::1]', '::ffff:7f00:1']) {
      await expect(destinationMail(h, 993, 'imap')).rejects.toBeInstanceOf(DestinationRefusee);
    }
  });

  it('refuse un port qui n’est pas un port mail', async () => {
    await expect(destinationMail('8.8.8.8', 22, 'imap')).rejects.toThrow(/Port IMAP 22/);
    await expect(destinationMail('8.8.8.8', 993, 'smtp')).rejects.toThrow(/Port SMTP 993/);
  });

  it('accepte une adresse publique et rend celle à laquelle se connecter', async () => {
    await expect(destinationMail('8.8.8.8', 993, 'imap')).resolves.toEqual({ host: '8.8.8.8' });
  });

  it('garde le nom d’origine pour le certificat TLS', async () => {
    // « localhost » se résout sans réseau ; autorisé ici pour vérifier la forme du résultat.
    process.env.COMET_MAIL_RESEAU_LOCAL = 'autorise';
    const d = await destinationMail('localhost', 587, 'smtp');
    expect(d.servername).toBe('localhost');
    expect(estAdressePrivee(d.host)).toBe(true);
  });

  it('suit les réglages de l’administrateur', async () => {
    process.env.COMET_MAIL_RESEAU_LOCAL = 'autorise';
    await expect(destinationMail('192.168.1.10', 993, 'imap')).resolves.toEqual({ host: '192.168.1.10' });
    process.env.COMET_MAIL_PORTS_LIBRES = 'oui';
    await expect(destinationMail('192.168.1.10', 10993, 'imap')).resolves.toEqual({ host: '192.168.1.10' });
  });
});

describe('Ajout d’un compte mail', () => {
  let token;
  beforeAll(async () => {
    token = (await request(app).post('/api/auth/login').send({ email: 'lea@comet.mail', password: 'comet1234' })).body.token;
  });

  it('refuse un serveur IMAP sur le réseau interne, sans s’y connecter', async () => {
    const r = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`).send({
      email: 'lea@exemple.fr', password: 'x', imapHost: '169.254.169.254', imapPort: 993, smtpHost: '8.8.8.8', smtpPort: 465,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/adresse locale ou privée/);
  });

  it('refuse un port arbitraire', async () => {
    const r = await request(app).post('/api/accounts').set('Authorization', `Bearer ${token}`).send({
      email: 'lea@exemple.fr', password: 'x', imapHost: '8.8.8.8', imapPort: 6379, smtpHost: '8.8.8.8', smtpPort: 465,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Port IMAP 6379/);
  });
});
