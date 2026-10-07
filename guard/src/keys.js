// Ed25519 signing keys. The private key never leaves the machine it was made on;
// only the public key (32 bytes, base64) is shared, e.g. with the arena.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// DER header that turns 32 raw bytes into an Ed25519 SubjectPublicKeyInfo.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicRaw(keyObject) {
  const der = createPublicKey(keyObject).export({ format: 'der', type: 'spki' });
  return der.subarray(SPKI_PREFIX.length).toString('base64');
}

export function publicKeyFromRaw(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new RangeError('public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Load the private key at `file`, creating it (mode 600) if missing. */
export function loadOrCreateKey(file) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
  }
  return createPrivateKey(readFileSync(file));
}

export function signText(privateKey, text) {
  return sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');
}

export function verifyText(publicKey, text, sigB64) {
  const key = typeof publicKey === 'string' ? publicKeyFromRaw(publicKey) : publicKey;
  try {
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
