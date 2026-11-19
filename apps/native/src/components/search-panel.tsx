// Port of apps/frontend/src/lib/components/search-panel.svelte
// Native: the query is typed in the panel itself (the header has no room for a search box), and it takes the
// place of the chat like the canvas does; Android's back closes it.
import { Hash, Paperclip } from 'lucide-react-native';
import {
  applySearchSuggestion,
  highlightMatches,
  searchSuggestions,
  searchWords,
} from 'anchor/message-search';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { SearchField } from '@/components/search-field';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { chat, useChat } from '@/lib/chat-state';
import { formatDate } from '@/lib/format-date';

type Result = NonNullable<
  Awaited<ReturnType<ReturnType<typeof chat>['searchMessages']>>['data']
>['messages'][number];

export function SearchPanel({
  guildId,
  channel,
  onClose,
}: {
  guildId: string | null;
  channel: { id: string; name: string };
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [wholeGuild, setWholeGuild] = useState(true);
  const [results, setResults] = useState<Result[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState('');
  const request = useRef(0);
  const scope = guildId && wholeGuild ? { guildId } : { channelId: channel.id };
  const words = searchWords(searched);
  const members = useChat((s) => s.members);
  // hints for the word being typed, hidden once that text has been searched
  const suggestions = text === query ? [] : searchSuggestions(text, guildId ? members : []);

  // a new query or scope starts over; older answers arriving late are dropped
  async function run(cursor: string | null = null) {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    const result = await chat().searchMessages(scope, query, cursor);
    if (id !== request.current) return;
    setLoading(false);
    if (result.error || !result.data) {
      const value = result.error?.value as { error?: string } | undefined;
      setError(value?.error ?? 'Search failed');
      if (!cursor) setResults([]);
      return;
    }
    const data = result.data;
    setSearched(query);
    setResults((previous) => (cursor ? [...previous, ...data.messages] : data.messages));
    setNextCursor(data.nextCursor);
  }

  useEffect(() => {
    if (query.trim()) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, wholeGuild]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  function open(result: Result) {
    onClose();
    void chat().jumpToMessage(result.channelId, result.id);
  }

  return (
    <View className="min-h-0 flex-1 bg-background">
      <View className="gap-2 border-b border-border p-3">
        <SearchField
          value={text}
          onChangeText={setText}
          placeholder={guildId ? 'Search server' : 'Search'}
          onSubmitEditing={() => setQuery(text.trim())}
          autoFocus
        />
        {suggestions.length ? (
          <View className="border border-border bg-popover">
            {suggestions.map((suggestion) => (
              <Pressable
                key={suggestion.value}
                accessibilityRole="button"
                accessibilityLabel={`${suggestion.label} ${suggestion.detail}`}
                onPress={() => setText(applySearchSuggestion(text, suggestion))}
                className="min-h-11 flex-row items-center gap-2 px-3 active:bg-accent"
              >
                <Text className="font-medium">{suggestion.label}</Text>
                <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
                  {suggestion.detail}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {guildId ? (
          <View className="flex-row gap-1" accessibilityRole="radiogroup">
            <Button
              variant={wholeGuild ? 'secondary' : 'ghost'}
              size="sm"
              accessibilityState={{ selected: wholeGuild }}
              onPress={() => setWholeGuild(true)}
            >
              <Text>Server</Text>
            </Button>
            <Button
              variant={wholeGuild ? 'ghost' : 'secondary'}
              size="sm"
              accessibilityState={{ selected: !wholeGuild }}
              onPress={() => setWholeGuild(false)}
            >
              <Text>#{channel.name}</Text>
            </Button>
          </View>
        ) : null}
      </View>

      {!query ? (
        <Text className="p-4 text-sm text-muted-foreground">
          Search messages. Filters: from:alice, has:link, has:attachment, before:2026-01-31,
          after:2026-01-01.
        </Text>
      ) : error ? (
        <Text className="p-4 text-sm text-destructive">{error}</Text>
      ) : loading && !results.length ? (
        <View className="items-center p-6">
          <Spinner />
        </View>
      ) : !results.length ? (
        <View className="p-4">
          <Text className="font-medium">No messages found</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Try other words, or filters like from:alice, has:link, has:attachment,
            before:2026-01-31, after:2026-01-01.
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View className="h-px bg-border" />}
          renderItem={({ item }) => {
            const name = item.author.displayName || item.author.username;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${name}: ${item.content ?? ''}`}
                onPress={() => open(item)}
                className="flex-row gap-3 px-3 py-3 active:bg-accent"
              >
                <Avatar
                  src={item.author.avatarUrl}
                  name={name}
                  className="size-9"
                  bgColor={item.author.avatarColor}
                />
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="shrink font-semibold" numberOfLines={1}>
                      {name}
                    </Text>
                    {item.guildId ? (
                      <View className="flex-row items-center">
                        <Icon as={Hash} size={12} className="text-muted-foreground" />
                        <Text className="text-xs text-muted-foreground">{item.channelName}</Text>
                      </View>
                    ) : null}
                    <Text className="ml-auto text-xs text-muted-foreground">
                      {formatDate(new Date(item.createdAt))}
                    </Text>
                  </View>
                  {item.content ? (
                    <Text className="text-sm" numberOfLines={3}>
                      {highlightMatches(item.content, words).map((piece, i) =>
                        piece.match ? (
                          <Text key={i} className="bg-primary/25 text-sm">
                            {piece.text}
                          </Text>
                        ) : (
                          piece.text
                        )
                      )}
                    </Text>
                  ) : null}
                  {item.attachments.length ? (
                    <View className="mt-0.5 flex-row items-center gap-1">
                      <Icon as={Paperclip} size={12} className="text-muted-foreground" />
                      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                        {item.attachments.map((attachment) => attachment.filename).join(', ')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
          ListFooterComponent={
            nextCursor ? (
              <View className="p-3">
                <Button variant="outline" disabled={loading} onPress={() => run(nextCursor)}>
                  <Text>{loading ? 'Loading…' : 'Load more'}</Text>
                </Button>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}
