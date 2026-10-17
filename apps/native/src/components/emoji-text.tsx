// Port of apps/frontend/src/lib/components/emoji-text.svelte
// Unicode emoji become the server's emoji images, links open in the in-app browser (Novarum links in the app) and mentions are pills.
import { Image } from 'expo-image';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Text } from '@/components/ui/text';
import { ProfileSheet } from '@/components/profile-card';
import { useChat } from '@/lib/chat-state';
import { openLink } from '@/lib/navigation';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import type { Author } from '@/lib/types/chat';
import { cn, isUrl, urlPattern } from '@/lib/utils';

const handleSource = '@[a-zA-Z0-9._]+:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?';
export const handlePattern = new RegExp(`(?<![a-zA-Z0-9._])${handleSource}`, 'g');
const mentionPattern = new RegExp(`((?<![a-zA-Z0-9._])${handleSource})`, 'g');
const mentionOnly = new RegExp(`^${handleSource}$`);
// Hermes has no Intl.Segmenter, so emoji sequences (flags, keycaps, skin tones, ZWJ) are matched by range
const pictograph =
  '[\\u{1F000}-\\u{1FAFF}\\u{231A}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}]';
const modifier = '\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?';
const emojiPattern = new RegExp(
  `([\\u{1F1E6}-\\u{1F1FF}]{2}|[#*0-9]\\uFE0F?\\u20E3|${pictograph}${modifier}(?:\\u200D${pictograph}${modifier})*)`,
  'u'
);

type Part = { text: string; url?: boolean; mention?: boolean; unicode?: string };

function parse(content: string, links: boolean) {
  return content.split(urlPattern).flatMap<Part>((text) => {
    if (links && isUrl(text)) return [{ text, url: true }];

    return text.split(mentionPattern).flatMap<Part>((part) => {
      if (mentionOnly.test(part)) return [{ text: part, mention: true }];

      // split with a capture group: odd entries are the emoji
      return part.split(emojiPattern).flatMap<Part>((piece, index) =>
        !piece
          ? []
          : index % 2
            ? [
                {
                  text: piece,
                  unicode: [...piece]
                    .map((character) => character.codePointAt(0)!.toString(16).toUpperCase())
                    .join('-'),
                },
              ]
            : [{ text: piece }]
      );
    });
  });
}

function mentionUser(mention: string): Author {
  const [username, server] = mention.slice(1).split(':');
  const member = useChat
    .getState()
    .members.find(
      (item) =>
        item.username.toLowerCase() === username.toLowerCase() &&
        item.server.toLowerCase() === server.toLowerCase()
    );

  return (
    member ?? {
      userId: '',
      username,
      server,
      displayName: null,
      avatarUrl: null,
      bannerUrl: null,
      about: null,
      isBot: false,
      avatarColor: null,
      speakingRingColor: null,
    }
  );
}

// Renders a <Text>. Pass `className` for the text style: <Text> always sets a size, so nothing is inherited.
export function EmojiText({
  content,
  links = false,
  className,
  children,
}: {
  content: string;
  links?: boolean;
  className?: string;
  // appended after the text, inside the same <Text> (message.tsx puts "(edited)" here)
  children?: ReactNode;
}) {
  const self = useSession((s) => s.user);
  const [profile, setProfile] = useState<Author | null>(null);
  const parts = useMemo(() => parse(content, links), [content, links]);
  const unicodes = useMemo(
    () => parts.flatMap((part) => (part.unicode ? [part.unicode] : [])),
    [parts]
  );
  // only this text's emojis, so a new emoji elsewhere doesn't re-render every message
  const urls = useRealtime(useShallow((s) => unicodes.map((unicode) => s.emojiUrls[unicode])));

  useEffect(() => {
    if (unicodes.length) useRealtime.getState().queryEmojis(unicodes);
  }, [unicodes]);

  return (
    <>
      <Text className={className}>
        {parts.map((part, index) => {
          if (part.url) {
            return (
              <Text
                key={index}
                className={cn(className, 'text-link underline')}
                onPress={() => openLink(part.text)}
              >
                {part.text}
              </Text>
            );
          }

          if (part.mention) {
            const isSelf = part.text === `@${self?.username}:${self?.homeserver}`;
            return (
              <Text
                key={index}
                className={cn(
                  className,
                  'font-medium text-link',
                  isSelf ? 'bg-link/25' : 'bg-link/10'
                )}
                onPress={links ? () => setProfile(mentionUser(part.text)) : undefined}
              >
                {part.text}
              </Text>
            );
          }

          const url = part.unicode && urls[unicodes.indexOf(part.unicode)];
          if (url) {
            return (
              <Image
                key={index}
                source={{ uri: url }}
                accessibilityLabel={part.text}
                contentFit="contain"
                style={{ width: 20, height: 20 }}
              />
            );
          }

          return part.text;
        })}
        {children}
      </Text>
      {profile && <ProfileSheet user={profile} open onClose={() => setProfile(null)} />}
    </>
  );
}
