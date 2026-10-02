import { mailpitUrl } from './env';
import { eventually } from './wait';

type Message = { ID: string; To: { Address: string }[]; Subject: string; Created: string };

export async function clearMail() {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}

export async function messagesFor(email: string): Promise<Message[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  return ((await res.json()) as { messages: Message[] }).messages ?? [];
}

/** waits for a mail to `email` that arrived after `since` and returns its first 6-digit code */
export async function latestOtpFor(email: string, { since = 0, timeout = 10_000 } = {}) {
  const message = await eventually(
    async () => (await messagesFor(email)).find((m) => new Date(m.Created).getTime() >= since),
    { timeout, message: `mail for ${email}` }
  );
  const res = await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`);
  const body = (await res.json()) as { Text: string; HTML: string };
  const code = /\b(\d{6})\b/.exec(body.Text || body.HTML.replace(/<[^>]+>/g, ' '));
  if (!code) throw new Error(`no code in mail: ${body.Text}`);
  return code[1]!;
}
