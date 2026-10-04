import crypto from 'node:crypto';
import { call } from './chat';
import type { TestUser } from './users';

export type ReceivedPush = { label: string; message: any };

/** a stand-in push service: records every notification POSTed to /<label>, decrypted for its subscriber */
export function startPushSink({ endpointHost = '127.0.0.1' } = {}) {
  const subscribers = new Map<string, { ecdh: crypto.ECDH; auth: Buffer }>();
  const received: ReceivedPush[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    async fetch(request) {
      const label = new URL(request.url).pathname.slice(1);
      const subscriber = subscribers.get(label);
      if (!subscriber) return new Response('gone', { status: 410 });
      const body = Buffer.from(await request.arrayBuffer());
      received.push({ label, message: decryptAes128gcm(body, subscriber.ecdh, subscriber.auth) });
      return new Response(null, { status: 201 });
    },
  });
  let counter = 0;

  return {
    received,
    for: (label: string) => received.filter((push) => push.label === label).map((p) => p.message),
    /** drops the device on the push service's side: the next push to it gets a 410 */
    forget: (label: string) => subscribers.delete(label),
    /** registers a device for `user` and returns the subscription id */
    async subscribe(user: Pick<TestUser, 'fetch'>, label = `device${counter++}`, kind = 'WEBPUSH') {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      const auth = crypto.randomBytes(16);
      subscribers.set(label, { ecdh, auth });
      const res = await call(user, 'POST', '/notifications/subscriptions', {
        kind,
        endpoint: `http://${endpointHost}:${server.port}/${label}`,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
      });
      if (res.status !== 200) throw new Error(`subscribe failed: ${res.status} ${JSON.stringify(res.body)}`);
      return { label, id: res.body.id as string };
    },
    /** gives a push that should not arrive time to show up */
    settle: () => Bun.sleep(600),
    stop: () => server.stop(true),
  };
}

// RFC 8291 (aes128gcm) from the user agent's side
function decryptAes128gcm(body: Buffer, ecdh: crypto.ECDH, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const serverKey = body.subarray(21, 21 + idLength);
  const encrypted = body.subarray(21 + idLength);
  const hkdf = (key: Buffer, info: Buffer, length: number, ikm: Buffer) =>
    Buffer.from(crypto.hkdfSync('sha256', ikm, key, info, length));

  const ikm = hkdf(
    auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]),
    32,
    ecdh.computeSecret(serverKey)
  );
  const key = hkdf(salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16, ikm);
  const nonce = hkdf(salt, Buffer.from('Content-Encoding: nonce\0'), 12, ikm);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
}
