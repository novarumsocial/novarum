// Port of apps/frontend/src/lib/components/message-embed.svelte
import { Image } from 'expo-image';
import { Linking, Pressable, View } from 'react-native';
import type { Embed } from 'anchor/bot-schemas';
import { Markdown } from './markdown';
import { Text } from './ui/text';
import { formatDate, formatTime } from '@/lib/format-date';

const open = (url?: string) => url && void Linking.openURL(url);

export function MessageEmbed({ embed }: { embed: Embed }) {
  // the bot picks the colour of the bar; without one it is the quiet border colour
  const accent =
    embed.color === undefined ? undefined : `#${embed.color.toString(16).padStart(6, '0')}`;
  const timestamp = embed.timestamp ? new Date(embed.timestamp) : null;

  return (
    <View
      className="mt-1.5 max-w-lg border border-l-4 border-border bg-card/60 py-2.5 pr-3 pl-3"
      style={accent ? { borderLeftColor: accent } : undefined}
    >
      <View className="flex-row gap-3">
        <View className="min-w-0 flex-1">
          {embed.author && (
            <Pressable
              disabled={!embed.author.url}
              onPress={() => open(embed.author?.url)}
              className="mb-1.5 flex-row items-center gap-1.5"
            >
              {embed.author.iconUrl && (
                <Image source={embed.author.iconUrl} style={{ width: 20, height: 20 }} />
              )}
              <Text className="text-xs font-medium" numberOfLines={1}>
                {embed.author.name}
              </Text>
            </Pressable>
          )}
          {embed.title && (
            <Text
              className={embed.url ? 'text-sm font-semibold text-link' : 'text-sm font-semibold'}
              onPress={embed.url ? () => open(embed.url) : undefined}
            >
              {embed.title}
            </Text>
          )}
          {embed.description && (
            <View className="mt-1">
              <Markdown
                content={embed.description}
                links
                className="text-sm leading-5 text-foreground/85"
              />
            </View>
          )}
          {!!embed.fields?.length && (
            <View className="mt-2 flex-row flex-wrap">
              {embed.fields.map((field, index) => (
                <View key={index} className={field.inline ? 'w-1/2 pr-3 pb-2' : 'w-full pb-2'}>
                  <Text className="text-xs font-semibold">{field.name}</Text>
                  <Markdown content={field.value} links className="text-sm text-foreground/85" />
                </View>
              ))}
            </View>
          )}
        </View>
        {embed.thumbnail && (
          <Image
            source={embed.thumbnail.url}
            style={{ width: 64, height: 64 }}
            contentFit="cover"
          />
        )}
      </View>

      {embed.image && (
        <Image
          source={embed.image.url}
          style={{ width: '100%', aspectRatio: 16 / 9, marginTop: 10 }}
          contentFit="contain"
        />
      )}

      {(embed.footer || timestamp) && (
        <View className="mt-2 flex-row items-center gap-1.5">
          {embed.footer?.iconUrl && (
            <Image source={embed.footer.iconUrl} style={{ width: 16, height: 16 }} />
          )}
          <Text className="shrink text-[11px] text-muted-foreground" numberOfLines={1}>
            {[
              embed.footer?.text,
              timestamp && `${formatDate(timestamp)} at ${formatTime(timestamp)}`,
            ]
              .filter(Boolean)
              .join('  •  ')}
          </Text>
        </View>
      )}
    </View>
  );
}
