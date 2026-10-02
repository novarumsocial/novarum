import crypto from 'node:crypto';

// standalone mirror of signFederationRequest in utils/discovery.ts (which reads keys from the DB).
// shared by the unit golden test and the federation tests, which use it to impersonate homeservers.
// signing string: v1\nMETHOD\npath\nhost\nhomeserver\ndate\nnonce\nbodyHash (ed25519, base64)
export type SignFederationRequestInput = {
  privateKeyB64: string; // pkcs8 der, base64
  keyId: string;
  method: string;
  path: string;
  host: string;
  homeserver: string;
  body: string;
  date?: string;
  nonce?: string;
};

export function signFederationRequestWith(input: SignFederationRequestInput) {
  const bodyHash = crypto.createHash('sha256').update(input.body, 'utf8').digest('base64');
  const date = input.date ?? new Date().toISOString();
  const nonce = input.nonce ?? crypto.randomUUID();

  const signingString = [
    'v1',
    input.method.toUpperCase(),
    input.path,
    input.host,
    input.homeserver,
    date,
    nonce,
    bodyHash,
  ].join('\n');

  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(input.privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = crypto
    .sign(null, Buffer.from(signingString, 'utf8'), privateKey)
    .toString('base64');

  return {
    signingString,
    headers: {
      'X-Novarum-Homeserver': input.homeserver,
      'X-Novarum-Key-Id': input.keyId,
      'X-Novarum-Date': date,
      'X-Novarum-Nonce': nonce,
      'X-Novarum-Body-SHA256': bodyHash,
      'X-Novarum-Signature': signature,
    },
  };
}

export function verifies(signingString: string, signature: string, publicKeyB64: string) {
  return crypto.verify(
    null,
    Buffer.from(signingString, 'utf8'),
    crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(signature, 'base64')
  );
}

export function generateKeyPairB64() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}
