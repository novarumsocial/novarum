// Native-only: the composer's emoji button. Common emoji up front, and a search over the server's emoji list
// (the same search `:name` uses).
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SearchField } from '@/components/search-field';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { realtime, useRealtime } from '@/lib/realtime';

const common = [
  '😀',
  '😂',
  '🥹',
  '😍',
  '😭',
  '😅',
  '🙂',
  '😉',
  '😎',
  '🤔',
  '😮',
  '😢',
  '😡',
  '👍',
  '👎',
  '👏',
  '🙏',
  '💪',
  '👀',
  '🔥',
  '❤️',
  '💯',
  '🎉',
  '✅',
];

const fromUnicode = (unicode: string) =>
  String.fromCodePoint(...unicode.split('-').map((part) => parseInt(part, 16)));

export function EmojiPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
}) {
  const [query, setQuery] = useState('');
  const emojiQuery = useRealtime((s) => s.emojiQuery);
  const results = useRealtime((s) => s.emojiResults);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (searching) realtime().searchEmojis(query);
  }, [query, searching]);

  const pick = (emoji: string) => {
    onPick(emoji);
    setQuery('');
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Emoji">
      <View className="gap-3 px-3 pt-3">
        <SearchField placeholder="Search emoji" value={query} onChangeText={setQuery} />
        <View className="flex-row flex-wrap">
          {searching
            ? (emojiQuery.trim() === query.trim() ? results : []).slice(0, 40).map((emoji) => (
                <Pressable
                  key={emoji.unicode}
                  accessibilityRole="button"
                  accessibilityLabel={emoji.name}
                  onPress={() => pick(fromUnicode(emoji.unicode))}
                  className="size-12 items-center justify-center active:bg-accent"
                >
                  <Image
                    source={{ uri: emoji.url }}
                    contentFit="contain"
                    style={{ width: 28, height: 28 }}
                  />
                </Pressable>
              ))
            : common.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={emoji}
                  onPress={() => pick(emoji)}
                  className="size-12 items-center justify-center active:bg-accent"
                >
                  <Text className="text-2xl">{emoji}</Text>
                </Pressable>
              ))}
        </View>
      </View>
    </Sheet>
  );
}
