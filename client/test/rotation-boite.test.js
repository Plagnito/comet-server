// Rotation des clés d'une boîte partagée au retrait d'un membre (C-20), de bout en bout
// côté chiffrement : ce que l'ex-membre peut encore ouvrir, et ce qu'il ne peut plus.
import { describe, it, expect } from 'vitest';
import {
  generateKeyPair, exportPublicKey, generateBoxIdentity, wrapKeyFor, unwrapKey, unwrapPrivateKeyAES,
  encryptMessage, decryptMessage, preparerRotationBoite, decryptMessageAvecCles,
} from '../src/crypto.js';

async function personne() { const kp = await generateKeyPair(); return { kp, pub: await exportPublicKey(kp) }; }

describe('rotation des clés d’une boîte partagée', () => {
  it('les membres restants lisent tout ; l’ex-membre ne lit plus rien de nouveau', async () => {
    const [proprio, membre, exMembre] = await Promise.all([personne(), personne(), personne()]);
    // Boîte d'origine : clé de boîte K1 distribuée aux trois.
    const v1 = await generateBoxIdentity();
    const encK1 = { proprio: await wrapKeyFor(v1.boxKey, proprio.pub), ex: await wrapKeyFor(v1.boxKey, exMembre.pub) };
    const priv1 = await unwrapPrivateKeyAES(v1.wrappedPrivateKey, await unwrapKey(encK1.proprio, proprio.kp.privateKey));
    const avant = await encryptMessage({ subject: 'Avant', body: 'courrier d’avant le retrait' }, { boite: v1.publicKey });

    // L'ex-membre a déverrouillé la boîte avant son retrait : il garde K1 et la clé privée v1.
    const K1Ex = await unwrapKey(encK1.ex, exMembre.kp.privateKey);
    const privEx = await unwrapPrivateKeyAES(v1.wrappedPrivateKey, K1Ex);

    // Rotation préparée par le propriétaire, pour les deux membres restants.
    const r = await preparerRotationBoite({ boxPrivateKey: priv1, oldPrivateKeys: [], clesMembres: { 1: proprio.pub, 2: membre.pub } });
    expect(r.publicKey).not.toBe(v1.publicKey);
    expect(Object.keys(r.members).sort()).toEqual(['1', '2']);
    expect(r.oldPrivateKeys).toHaveLength(1);
    const apres = await encryptMessage({ subject: 'Après', body: 'courrier d’après le retrait' }, { boite: r.publicKey });

    // Le membre restant (qui n'avait pas encore K1) déverrouille la nouvelle version.
    const K2 = await unwrapKey(r.members[2], membre.kp.privateKey);
    const priv2 = await unwrapPrivateKeyAES(r.wrappedPrivateKey, K2);
    const anciennes = await Promise.all(r.oldPrivateKeys.map((k) => unwrapPrivateKeyAES(k, K2)));
    const cles = [priv2, ...anciennes];
    expect((await decryptMessageAvecCles(apres.ciphertext, apres.iv, apres.keys.boite, cles)).subject).toBe('Après');
    expect((await decryptMessageAvecCles(avant.ciphertext, avant.iv, avant.keys.boite, cles)).subject).toBe('Avant');

    // L'ex-membre : ce qu'il avait déjà, il l'a (limite documentée)…
    expect((await decryptMessage(avant.ciphertext, avant.iv, avant.keys.boite, privEx)).subject).toBe('Avant');
    // …mais ni le nouveau courrier, ni la nouvelle clé privée de la boîte.
    await expect(decryptMessage(apres.ciphertext, apres.iv, apres.keys.boite, privEx)).rejects.toThrow();
    await expect(unwrapPrivateKeyAES(r.wrappedPrivateKey, K1Ex)).rejects.toThrow();
    await expect(unwrapKey(r.members[1], exMembre.kp.privateKey)).rejects.toThrow();
  });

  it('une deuxième rotation garde tout l’historique, la plus récente clé d’abord', async () => {
    const [proprio] = await Promise.all([personne()]);
    const v1 = await generateBoxIdentity();
    const priv1 = await unwrapPrivateKeyAES(v1.wrappedPrivateKey, v1.boxKey);
    const m1 = await encryptMessage({ subject: 'v1' }, { b: v1.publicKey });
    const r2 = await preparerRotationBoite({ boxPrivateKey: priv1, clesMembres: { 1: proprio.pub } });
    const K2 = await unwrapKey(r2.members[1], proprio.kp.privateKey);
    const priv2 = await unwrapPrivateKeyAES(r2.wrappedPrivateKey, K2);
    const olds2 = await Promise.all(r2.oldPrivateKeys.map((k) => unwrapPrivateKeyAES(k, K2)));
    const m2 = await encryptMessage({ subject: 'v2' }, { b: r2.publicKey });
    const r3 = await preparerRotationBoite({ boxPrivateKey: priv2, oldPrivateKeys: olds2, clesMembres: { 1: proprio.pub } });
    expect(r3.oldPrivateKeys).toHaveLength(2);
    const K3 = await unwrapKey(r3.members[1], proprio.kp.privateKey);
    const cles = [await unwrapPrivateKeyAES(r3.wrappedPrivateKey, K3), ...await Promise.all(r3.oldPrivateKeys.map((k) => unwrapPrivateKeyAES(k, K3)))];
    expect((await decryptMessageAvecCles(m1.ciphertext, m1.iv, m1.keys.b, cles)).subject).toBe('v1');
    expect((await decryptMessageAvecCles(m2.ciphertext, m2.iv, m2.keys.b, cles)).subject).toBe('v2');
  });

  it('aucune clé ne convient : erreur claire', async () => {
    const autre = await personne();
    const m = await encryptMessage({ subject: 'x' }, { b: (await generateBoxIdentity()).publicKey });
    await expect(decryptMessageAvecCles(m.ciphertext, m.iv, m.keys.b, [autre.kp.privateKey, null])).rejects.toThrow(/Aucune clé/);
  });
});
