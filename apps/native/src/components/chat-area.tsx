// Port of apps/frontend/src/lib/components/chat-area.svelte
// The message list is a FlashList that starts at the bottom, keeps the visible message in place when older
// pages are prepended and follows new messages while you are near the bottom.
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { BellRing, ChevronDown, Hash, Phone, RotateCw, Users, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { KeyboardAvoidingView, KeyboardEvents } from 'react-native-keyboard-controller';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Avatar } from '@/components/avatar';
import { Message } from '@/components/message';
import { MessageInput } from '@/components/message-input';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { chat, useChat, type PickedFile, type TypingInput } from '@/lib/chat-state';
import { useDms } from '@/lib/dms';
import { formatDate } from '@/lib/format-date';
import { useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import type { Channel, Message as ChatMessage } from '@/lib/types/chat';
import { cn } from '@/lib/utils';

type Row =
  | { kind: 'day'; key: string; date: Date }
  | { kind: 'new'; key: string }
  | {
      kind: 'message';
      key: string;
      message: ChatMessage;
      replied: ChatMessage | null;
      grouped: boolean;
    }
  | { kind: 'pending'; key: string; pending: Pending };

// an optimistic message: shown right away, dropped once the server has accepted it, kept for a retry if it failed
type Pending = {
  id: string;
  channelId: string;
  content: string | null;
  files: PickedFile[];
  replyTo: string | null;
  failed: boolean;
};

const noCallers: { name: string | null }[] = [];
const noTyping: TypingInput[] = [];
const GROUP_WINDOW = 5 * 60 * 1000;

function Skeletons({ count }: { count: number }) {
  return (
    <View className="gap-5 px-3 pt-4">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} className={cn('flex-row gap-3', i > 2 && 'opacity-60')}>
          <View className="mt-0.5 size-9 animate-pulse bg-muted" />
          <View className="min-w-0 flex-1 gap-2">
            <View className="flex-row items-center gap-2">
              <View className="h-3 w-24 animate-pulse bg-muted" />
              <View className="h-2 w-10 animate-pulse bg-muted/70" />
            </View>
            <View className="h-3 w-3/4 animate-pulse bg-muted" />
            <View className="h-3 w-1/2 animate-pulse bg-muted/70" />
          </View>
        </View>
      ))}
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const lift = useSharedValue(0);
  useEffect(() => {
    lift.value = withDelay(
      delay,
      withRepeat(
        withSequence(withTiming(-3, { duration: 300 }), withTiming(0, { duration: 300 })),
        -1
      )
    );
  }, [delay, lift]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));
  return <Animated.View style={style} className="size-1 rounded-full bg-muted-foreground" />;
}

function PendingMessage({
  pending,
  onRetry,
  onDiscard,
}: {
  pending: Pending;
  onRetry: (pending: Pending) => void;
  onDiscard: (pending: Pending) => void;
}) {
  const self = useSession((s) => s.user);
  const name = self?.displayName || self?.username || 'You';
  const attachments = `${pending.files.length} attachment${pending.files.length === 1 ? '' : 's'}`;

  return (
    <View className="mt-4 flex-row gap-3 px-3 py-0.5">
      <Avatar
        src={self?.avatarUrl}
        name={name}
        bgColor={self?.avatarColor}
        className="mt-0.5 size-9"
      />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold" numberOfLines={1}>
          {name}
        </Text>
        <View className={pending.failed ? undefined : 'opacity-60'}>
          {pending.content ? (
            <Text className="text-[15px] leading-[22px] text-foreground/90">{pending.content}</Text>
          ) : null}
          {pending.files.length > 0 && (
            <Text className="text-xs text-muted-foreground">{attachments}</Text>
          )}
        </View>
        {pending.failed ? (
          <View className="flex-row items-center">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Message failed to send. Tap to retry"
              onPress={() => onRetry(pending)}
              className="min-h-11 flex-1 flex-row items-center gap-1.5 active:opacity-70"
            >
              <Icon as={RotateCw} size={14} className="text-destructive" />
              <Text className="shrink text-xs text-destructive">Failed to send. Tap to retry</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Discard message"
              onPress={() => onDiscard(pending)}
              className="size-11 items-center justify-center active:bg-accent"
            >
              <Icon as={X} size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
        ) : (
          <Text accessibilityLiveRegion="polite" className="text-[11px] text-muted-foreground">
            Sending…
          </Text>
        )}
      </View>
    </View>
  );
}

function Divider({ label, className }: { label: string; className: string }) {
  return (
    <View accessibilityRole="header" className="my-3 flex-row items-center gap-2 px-3">
      <View className={cn('h-px flex-1', className)} />
      <Text className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
        {label}
      </Text>
      <View className={cn('h-px flex-1', className)} />
    </View>
  );
}

export function ChatArea({
  channel,
  messages,
  loading = false,
  activeMessage = null,
  onSend,
  onDelete,
  onEdit,
  onOpenMembers,
  onCall,
  onRing,
  call,
  callExpanded = false,
}: {
  channel: Channel;
  messages: ChatMessage[];
  loading?: boolean;
  // the message the link points at: scrolled to and flashed
  activeMessage?: string | null;
  onSend?: (
    content: string | null,
    files: PickedFile[],
    replyTo: string | null
  ) => void | Promise<void>;
  onDelete: (messageId: string) => void | Promise<void>;
  onEdit: (messageId: string, content: string | null) => void | Promise<void>;
  // members of a guild channel (phones open them over the chat)
  onOpenMembers?: () => void;
  onCall?: () => void;
  onRing?: () => void;
  // the embedded DM call (the web's `call` snippet)
  call?: ReactNode;
  callExpanded?: boolean;
}) {
  const { height } = useWindowDimensions();
  const circleIcons = useSettings((s) => s.circleIcons);
  const selfId = useSession((s) => s.user?.id);
  const typing = useChat((s) => s.typingByChannel[channel.id] ?? noTyping);
  const olderLoading = useChat((s) => s.loadingOlderByChannel[channel.id] ?? false);
  const callers = useChat((s) =>
    channel.type === 'DM' ? (s.voiceStates[channel.id] ?? noCallers) : noCallers
  );
  const ringing = useDms((s) => !!call && s.outgoingCall === channel.id);

  const list = useRef<FlashListRef<Row>>(null);
  const atBottom = useRef(true);
  const lastMessageId = useRef<string | null>(null);
  const [away, setAway] = useState(false);
  const [unreadBoundary, setUnreadBoundary] = useState<{
    channelId: string;
    lastReadMessageId: string | null;
  } | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);

  // the call panel's height, dragged with its bottom handle
  const callHeight = useSharedValue(320);
  const callStart = useSharedValue(320);
  const callStyle = useAnimatedStyle(() => ({ height: callHeight.value }));
  const resizeCall = Gesture.Pan()
    .onBegin(() => {
      callStart.value = callHeight.value;
    })
    .onUpdate((event) => {
      callHeight.value = Math.min(
        Math.max(callStart.value + event.translationY, 160),
        height * 0.7
      );
    });

  // new channel: the "New" divider and the reply bar start over (same as the web's effect)
  useEffect(() => {
    setUnreadBoundary(
      channel.unread
        ? { channelId: channel.id, lastReadMessageId: channel.lastReadMessageId }
        : null
    );
    setReplyingTo(null);
    atBottom.current = true;
    lastMessageId.current = null;
    setAway(false);
    // only when the channel changes, not on every unread update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  const rows = useMemo(() => {
    const byId = new Map(messages.map((message) => [message.id, message]));
    let firstUnreadIndex = -1;
    if (unreadBoundary?.channelId === channel.id) {
      const lastRead = unreadBoundary.lastReadMessageId
        ? messages.findIndex((message) => message.id === unreadBoundary.lastReadMessageId)
        : -1;
      firstUnreadIndex = lastRead < 0 ? 0 : lastRead < messages.length - 1 ? lastRead + 1 : -1;
    }

    const result: Row[] = [];
    messages.forEach((message, i) => {
      const prev = messages[i - 1];
      const firstUnread = i === firstUnreadIndex;
      const grouped =
        !firstUnread &&
        prev !== undefined &&
        prev.author.username === message.author.username &&
        prev.author.server === message.author.server &&
        message.timestamp.getTime() - prev.timestamp.getTime() < GROUP_WINDOW;

      if (!prev || message.timestamp.toDateString() !== prev.timestamp.toDateString()) {
        result.push({ kind: 'day', key: `day-${message.id}`, date: message.timestamp });
      }
      if (firstUnread) result.push({ kind: 'new', key: `new-${channel.id}` });
      result.push({
        kind: 'message',
        key: message.id,
        message,
        replied: (message.replyTo && byId.get(message.replyTo)) || null,
        grouped,
      });
    });
    for (const item of pending) {
      if (item.channelId === channel.id) {
        result.push({ kind: 'pending', key: `pending-${item.id}`, pending: item });
      }
    }
    return result;
  }, [messages, pending, unreadBoundary, channel.id]);

  const typingText =
    typing.length === 0
      ? null
      : typing.length === 1
        ? `${typing[0].name} is typing...`
        : typing.length === 2
          ? `${typing[0].name} and ${typing[1].name} are typing...`
          : 'Several people are typing...';

  // jump to the message the route points at (links, notifications, tapping a reply)
  useEffect(() => {
    if (!activeMessage || loading) return;
    const index = rows.findIndex((row) => row.kind === 'message' && row.key === activeMessage);
    if (index >= 0) void list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  }, [activeMessage, loading, rows]);

  // your own new message always scrolls into view, even when you were reading further up
  useEffect(() => {
    const last = messages.at(-1);
    if (!last || last.id === lastMessageId.current) return;
    const first = lastMessageId.current === null;
    lastMessageId.current = last.id;
    if (!first && last.author.userId === selfId) list.current?.scrollToEnd({ animated: true });
  }, [messages, selfId]);

  // the list shrinks when the keyboard opens, so stay on the latest message if we were there
  useEffect(() => {
    const subscription = KeyboardEvents.addListener('keyboardDidShow', () => {
      if (atBottom.current) list.current?.scrollToEnd({ animated: false });
    });
    return () => subscription.remove();
  }, []);

  // the shell may pass new functions on every render; rows get stable ones
  const handlers = useRef({ onDelete, onEdit, onSend });
  handlers.current = { onDelete, onEdit, onSend };
  const deleteMessage = useCallback((id: string) => handlers.current.onDelete(id), []);
  const editMessage = useCallback(
    (id: string, content: string | null) => handlers.current.onEdit(id, content),
    []
  );
  // the web clears the id off the url once the flash is over (so tapping the same reply flashes again)
  const flashEnd = useCallback(() => router.setParams({ rest: [channel.id] }), [channel.id]);

  // sends in the background: the composer clears right away and the message waits in the list as "sending"
  const send = useCallback(async (item: Pending) => {
    setPending((list) => list.map((p) => (p.id === item.id ? { ...p, failed: false } : p)));
    try {
      await handlers.current.onSend?.(item.content, item.files, item.replyTo);
      setPending((list) => list.filter((p) => p.id !== item.id));
    } catch {
      setPending((list) => list.map((p) => (p.id === item.id ? { ...p, failed: true } : p)));
    }
  }, []);
  const discard = useCallback(
    (item: Pending) => setPending((list) => list.filter((p) => p.id !== item.id)),
    []
  );

  function sendMessage(content: string | null, files: PickedFile[]) {
    const item: Pending = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      channelId: channel.id,
      content,
      files,
      replyTo: replyingTo?.id ?? null,
      failed: false,
    };
    setPending((list) => [...list, item]);
    setUnreadBoundary(null);
    setReplyingTo(null);
    void send(item);
  }

  // a new pending message scrolls into view, like your own sent messages do
  const pendingCount = pending.filter((item) => item.channelId === channel.id).length;
  useEffect(() => {
    if (pendingCount > 0) list.current?.scrollToEnd({ animated: true });
  }, [pendingCount]);

  function onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    atBottom.current = distance < 80;
    setAway(distance > 400);
  }

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === 'day') {
        return <Divider label={formatDate(item.date)} className="bg-muted-foreground/20" />;
      }
      if (item.kind === 'new') return <Divider label="New" className="bg-destructive" />;
      if (item.kind === 'pending') {
        return <PendingMessage pending={item.pending} onRetry={send} onDiscard={discard} />;
      }

      return (
        <Message
          message={item.message}
          repliedMessage={item.replied}
          grouped={item.grouped}
          onDelete={deleteMessage}
          onEdit={editMessage}
          onReply={setReplyingTo}
          flash={item.message.id === activeMessage}
          onFlashEnd={flashEnd}
        />
      );
    },
    [activeMessage, deleteMessage, editMessage, flashEnd, send, discard]
  );

  const callerNames = callers.map((state) => state.name ?? 'Someone').join(', ');

  return (
    <View className="min-h-0 min-w-0 flex-1 bg-background">
      <ScreenHeader
        actions={
          channel.type === 'DM' ? (
            !call ? (
              <Button variant="ghost" size="icon" accessibilityLabel="Start call" onPress={onCall}>
                <Icon as={Phone} size={20} />
              </Button>
            ) : callers.length <= 1 && !ringing ? (
              <Button variant="ghost" size="icon" accessibilityLabel="Ring" onPress={onRing}>
                <Icon as={BellRing} size={20} />
              </Button>
            ) : null
          ) : (
            onOpenMembers && (
              <Button
                variant="ghost"
                size="icon"
                accessibilityLabel="Open members"
                onPress={onOpenMembers}
              >
                <Icon as={Users} size={20} />
              </Button>
            )
          )
        }
      >
        {channel.type === 'DM' ? (
          <Avatar
            src={channel.avatarUrl}
            name={channel.name}
            className="size-7"
            bgColor={channel.avatarColor}
          />
        ) : (
          <Icon as={Hash} size={20} className="text-muted-foreground" />
        )}
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] font-semibold" numberOfLines={1}>
            {channel.name}
          </Text>
          {channel.topic ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {channel.topic}
            </Text>
          ) : null}
        </View>
      </ScreenHeader>

      {!call && callers.length > 0 && (
        <View className="flex-row items-center gap-2 border-b border-border bg-primary/5 px-4 py-2">
          <Icon as={Phone} size={16} className="text-green-500" />
          <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
            {callerNames} {callers.length === 1 ? 'is' : 'are'} in the call
          </Text>
          <Button className="bg-green-600" onPress={onCall}>
            <Text className="text-white">Join</Text>
          </Button>
        </View>
      )}

      {call && (
        <Animated.View
          style={callExpanded ? undefined : callStyle}
          className={cn('border-b border-border', callExpanded ? 'flex-1' : 'shrink-0')}
        >
          {call}
          {ringing && (
            <View pointerEvents="none" className="absolute inset-x-0 top-3 z-10 items-center px-4">
              <View
                className={cn(
                  'flex-row items-center gap-2 border border-border bg-sidebar/80 py-1.5 pr-3 pl-1.5',
                  circleIcons && 'rounded-full'
                )}
              >
                <Avatar
                  src={channel.avatarUrl}
                  name={channel.name}
                  className="size-6 animate-pulse"
                  bgColor={channel.avatarColor}
                />
                <Text className="text-sm" numberOfLines={1}>
                  Ringing {channel.name}…
                </Text>
              </View>
            </View>
          )}
          {!callExpanded && (
            <GestureDetector gesture={resizeCall}>
              <View
                accessibilityRole="adjustable"
                accessibilityLabel="Resize call"
                className="absolute inset-x-0 -bottom-3 z-10 h-6 items-center justify-center"
              >
                <View className="h-1 w-10 bg-muted-foreground/50" />
              </View>
            </GestureDetector>
          )}
        </Animated.View>
      )}

      <KeyboardAvoidingView
        behavior="padding"
        style={call && callExpanded ? { display: 'none' } : { flex: 1, minHeight: 0 }}
      >
        <View className="min-h-0 flex-1">
          {loading ? (
            <View className="flex-1 justify-end pb-4">
              <Skeletons count={5} />
            </View>
          ) : messages.length === 0 && rows.length === 0 ? (
            <View className="flex-1 items-start justify-end gap-3 p-4">
              {channel.type === 'DM' && (
                <Avatar
                  src={channel.avatarUrl}
                  name={channel.name}
                  className="size-14"
                  bgColor={channel.avatarColor}
                />
              )}
              <View className="border border-dashed border-border p-4">
                <Text className="text-sm font-medium">
                  {channel.type === 'DM'
                    ? `This is the beginning of your conversation with ${channel.name}.`
                    : 'No messages yet'}
                </Text>
                {channel.type !== 'DM' && (
                  <Text className="mt-1 text-sm text-muted-foreground">
                    Start the conversation in #{channel.name}.
                  </Text>
                )}
              </View>
            </View>
          ) : (
            <FlashList
              key={channel.id}
              ref={list}
              data={rows}
              extraData={activeMessage}
              keyExtractor={(row) => row.key}
              getItemType={(row) => row.kind}
              renderItem={renderItem}
              maintainVisibleContentPosition={{
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 0.2,
              }}
              onStartReached={() => void chat().loadOlderMessages(channel.id)}
              onStartReachedThreshold={1}
              onScroll={onScroll}
              scrollEventThrottle={64}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              ListHeaderComponent={
                olderLoading ? (
                  <View className="items-center py-3">
                    <Spinner />
                  </View>
                ) : null
              }
              ListFooterComponent={<View className="h-6" />}
            />
          )}

          {away && !loading && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Jump to latest"
              onPress={() => {
                void Haptics.selectionAsync();
                list.current?.scrollToEnd({ animated: true });
              }}
              className={cn(
                'absolute right-3 bottom-8 size-11 items-center justify-center border border-border bg-card active:bg-accent',
                circleIcons && 'rounded-full'
              )}
            >
              <Icon as={ChevronDown} size={20} />
            </Pressable>
          )}

          {typingText && (
            <View
              pointerEvents="none"
              accessibilityLiveRegion="polite"
              className="absolute inset-x-0 bottom-0 h-6 flex-row items-center gap-2.5 bg-background/90 px-3"
            >
              <View className="flex-row items-center gap-0.5">
                <Dot delay={0} />
                <Dot delay={150} />
                <Dot delay={300} />
              </View>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {typingText}
              </Text>
            </View>
          )}
        </View>

        {replyingTo && (
          <View className="min-h-11 flex-row items-center gap-2 border-t border-border pl-3">
            <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={1}>
              Replying to{' '}
              <Text className="text-xs font-medium">
                {replyingTo.author.displayName || replyingTo.author.username}
              </Text>
            </Text>
            <Button
              variant="ghost"
              size="icon"
              accessibilityLabel="Cancel reply"
              onPress={() => setReplyingTo(null)}
            >
              <Icon as={X} size={16} />
            </Button>
          </View>
        )}

        <MessageInput
          placeholder={
            channel.type === 'DM' ? `Message @${channel.name}` : `Message #${channel.name}`
          }
          onSend={sendMessage}
          onTyping={() => void chat().onTyping()}
          focusOn={replyingTo?.id ?? null}
        />
      </KeyboardAvoidingView>
    </View>
  );
}
