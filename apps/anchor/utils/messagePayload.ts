import { attachmentPayload } from './attachments';
import { publicUser } from './publicUser';
import type { ActionRow, Embed, MessageInteraction } from './botSchemas';
import type { SystemMessage } from './systemMessage';

type MessageRow = {
  id: string;
  channelId: string;
  content: string | null;
  nonce: string;
  replyTo: string | null;
  createdAt: Date;
  updatedAt: Date;
  embeds?: Embed[] | null;
  components?: ActionRow[] | null;
  interaction?: MessageInteraction | null;
  system?: SystemMessage | null;
  attachments: Parameters<typeof attachmentPayload>[0][];
};

/** What bots (or the homeserver, for system messages) added to a message, as every message response and event carries it. */
export const messageExtras = (
  message: Pick<MessageRow, 'embeds' | 'components' | 'interaction' | 'system'>
) => ({
  embeds: message.embeds ?? [],
  components: message.components ?? [],
  interaction: message.interaction ?? null,
  system: message.system ?? null,
});

/** A stored message as clients see it. */
export function messagePayload(
  message: MessageRow,
  channel: { guildId: string | null },
  author: Parameters<typeof publicUser>[0],
  pingedHandles: string[] = []
) {
  const edited = message.updatedAt.getTime() > message.createdAt.getTime();
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: channel.guildId,
    content: message.content,
    nonce: message.nonce,
    replyTo: message.replyTo ?? null,
    edited,
    editedTime: edited ? message.updatedAt.toISOString() : undefined,
    pingedHandles,
    attachments: message.attachments.map(attachmentPayload),
    createdAt: message.createdAt.toISOString(),
    author: publicUser(author),
    ...messageExtras(message),
  };
}
