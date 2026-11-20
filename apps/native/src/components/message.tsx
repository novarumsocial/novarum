// Port of apps/frontend/src/lib/components/message.svelte
// The hover toolbar and right-click menu become a long-press sheet, and swiping a row left replies. Editing
// happens in the composer (chat-area), like the reply bar, not inside the scrolling list.
// Rows stay cheap to mount (a channel opens with ~20 of them at once): the swipe is a JS PanResponder with a
// core Animated value instead of a native gesture handler and Reanimated hooks per row.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import {
  Copy,
  Download,
  EyeOff,
  SquareSlash,
  FileText,
  IdCardLanyard,
  Link,
  Pencil,
  Reply,
  SmilePlus,
  Trash2,
} from 'lucide-react-native';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, PanResponder, Pressable, View } from 'react-native';
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { Avatar } from '@/components/avatar';
import { AudioPlayer } from '@/components/audio-player';
import { BotBadge } from '@/components/bot-badge';
import { EmojiPicker } from '@/components/emoji-picker';
import { MessageComponents } from '@/components/message-components';
import { MessageEmbed } from '@/components/message-embed';
import { openAttachmentViewer, openFileWith } from '@/components/attachment-viewer';
import { handlePattern } from '@/components/emoji-text';
import { Markdown } from '@/components/markdown';
import { ProfileCard } from '@/components/profile-card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { VideoPlayer } from '@/components/video-player';
import { chat, selectActiveChannel, useChat } from '@/lib/chat-state';
import { formatDate, formatTime } from '@/lib/format-date';
import { goto } from '@/lib/navigation';
import { useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { toast } from '@/lib/toast';
import type { Attachment, Message as ChatMessage, Reaction } from '@/lib/types/chat';
import { cn, formatBytes, mentionsEveryone } from '@/lib/utils';

// where shared message links point (the same host the app opens as a deep link)
const webOrigin = 'https://app.novarum.me';
const SWIPE_THRESHOLD = 56;
const SWIPE_MAX = 80;
const bodyClass = 'text-base leading-6 text-foreground/90';

// "14:05" today, "Yesterday 14:05", "12 Nov 2026 14:05" before: grouped rows hide the day divider's context
const stamp = (date: Date) => {
  const day = formatDate(date);
  return day === 'Today' ? formatTime(date) : `${day} ${formatTime(date)}`;
};

export const startEditing = (message: ChatMessage) =>
  useChat.setState({ editingMessage: true, editingMessageId: message.id });

// the server doesn't send image sizes, so remember them once an image has loaded (keeps list rows from jumping)
const imageSizes = new Map<string, { width: number; height: number }>();
// a single image is shown whole, at most this big (and never larger than it is)
const MAX_IMAGE_WIDTH = 300;
const MAX_IMAGE_HEIGHT = 340;

const isImage = (a: Attachment) => a.contentType.startsWith('image/');
const isVideo = (a: Attachment) => a.contentType.startsWith('video/');
const isAudio = (a: Attachment) => a.contentType.startsWith('audio/');
const isPdf = (a: Attachment) => a.contentType === 'application/pdf';

// the highlight over the message a link points at; only mounted on that one row
function Flash({ onEnd }: { onEnd?: () => void }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withDelay(
      300,
      withTiming(0, { duration: 1200 }, (finished) => {
        if (finished && onEnd) runOnJS(onEnd)();
      })
    );
  }, [opacity, onEnd]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Reanimated.View
      pointerEvents="none"
      style={style}
      className="absolute inset-0 bg-primary/20"
    />
  );
}

function ImageTile({
  attachment,
  single,
  onPress,
}: {
  attachment: Attachment;
  single: boolean;
  onPress: () => void;
}) {
  const [size, setSize] = useState(
    imageSizes.get(attachment.id) ??
      (attachment.width && attachment.height
        ? { width: attachment.width, height: attachment.height }
        : { width: 400, height: 300 })
  );
  const aspect = size.width / size.height;

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`View ${attachment.filename}`}
      onPress={onPress}
      className={cn(
        'overflow-hidden border border-border bg-muted/30 active:opacity-80',
        !single && 'aspect-square w-full'
      )}
      style={
        single
          ? {
              width: Math.min(size.width, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT * aspect),
              maxWidth: '100%',
              aspectRatio: aspect,
            }
          : undefined
      }
    >
      <Image
        source={{ uri: attachment.previewUrl }}
        recyclingKey={attachment.id}
        contentFit="cover"
        onLoad={(event) => {
          if (!single || attachment.width || !event.source.width || !event.source.height) return;
          const { width, height } = event.source;
          imageSizes.set(attachment.id, { width, height });
          setSize({ width, height });
        }}
        style={{ width: '100%', height: '100%' }}
      />
    </Pressable>
  );
}

function FileTile({ attachment, onPress }: { attachment: Attachment; onPress: () => void }) {
  const pdf = isPdf(attachment);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pdf ? 'View' : 'Open'} ${attachment.filename}`}
      onPress={onPress}
      className="min-h-14 w-full flex-row items-center gap-3 border border-input bg-background p-2 active:bg-accent"
    >
      <View className="size-10 items-center justify-center bg-muted">
        <Icon as={FileText} size={18} className="text-primary" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium" numberOfLines={2}>
          {attachment.filename}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {pdf ? 'PDF · tap to view' : formatBytes(attachment.size)}
        </Text>
      </View>
      {!pdf && <Icon as={Download} size={18} className="text-muted-foreground" />}
    </Pressable>
  );
}

// the reactions under a message: tap one to add or take back yours, the last chip adds a new one
function Reactions({
  reactions,
  onToggle,
  onAdd,
}: {
  reactions: Reaction[];
  onToggle: (reaction: Reaction) => void;
  onAdd: () => void;
}) {
  return (
    <View className="mt-1.5 flex-row flex-wrap gap-1">
      {reactions.map((reaction) => (
        <Pressable
          key={reaction.emoji}
          accessibilityRole="button"
          accessibilityState={{ selected: reaction.me }}
          accessibilityLabel={`${reaction.emoji} ${reaction.count}, ${reaction.users
            .map((user) => user.displayName || user.username)
            .join(', ')}`}
          onPress={() => onToggle(reaction)}
          hitSlop={4}
          className={cn(
            'h-8 flex-row items-center gap-1 border px-2 active:opacity-70',
            reaction.me ? 'border-primary/60 bg-primary/15' : 'border-border bg-muted/30'
          )}
        >
          <Text className="text-base leading-5">{reaction.emoji}</Text>
          <Text
            className={cn('text-sm', reaction.me ? 'text-foreground' : 'text-muted-foreground')}
          >
            {reaction.count}
          </Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add reaction"
        onPress={onAdd}
        hitSlop={4}
        className="h-8 items-center justify-center border border-border px-2 active:bg-accent"
      >
        <Icon as={SmilePlus} size={16} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
}

function MessageMenu({
  message,
  own,
  open,
  onClose,
  onReply,
  onReact,
  onDelete,
}: {
  message: ChatMessage;
  own: boolean;
  open: boolean;
  onClose: () => void;
  onReply: () => void;
  onReact: () => void;
  onDelete: () => void;
}) {
  const developerMode = useSettings((s) => s.developerMode);
  // run the action once the sheet has started closing
  const then = (action: () => void) => () => {
    onClose();
    action();
  };
  const copy = (text: string, what: string) =>
    then(() => {
      void Clipboard.setStringAsync(text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(`${what} copied`);
    });
  const localOnly = !!message.ephemeral || !!message.thinking;
  const text = message.content?.trim() ?? '';
  const attachments = message.attachments.length;
  const edited = message.edited && message.editedTime ? new Date(message.editedTime) : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      // grouped messages hide their time, so the sheet always says who sent it, when, and what it said
      title={`${message.author.displayName || message.author.username} · ${stamp(message.timestamp)}`}
      subtitle={
        (text || `${attachments} attachment${attachments === 1 ? '' : 's'}`) +
        (edited ? `\nEdited ${stamp(edited)}` : '')
      }
    >
      {/* ephemeral answers and "thinking…" only exist on this screen: nothing to reply to, link or delete */}
      {!localOnly && <SheetItem icon={Reply} label="Reply" onPress={then(onReply)} />}
      {!localOnly && <SheetItem icon={SmilePlus} label="Add reaction" onPress={then(onReact)} />}
      {own && text && !localOnly && (
        <SheetItem icon={Pencil} label="Edit message" onPress={then(() => startEditing(message))} />
      )}
      {text ? (
        <SheetItem icon={Copy} label="Copy text" onPress={copy(message.content, 'Text')} />
      ) : null}
      {!localOnly && (
        <SheetItem
          icon={Link}
          label="Copy message link"
          onPress={copy(`${webOrigin}${chat().messagePath(message.id)}`, 'Link')}
        />
      )}
      {!localOnly && developerMode && (
        <SheetItem
          icon={IdCardLanyard}
          label="Copy message ID"
          onPress={copy(message.id, 'Message ID')}
        />
      )}
      {own && (
        <View className="mt-2 border-t border-border pt-2">
          <SheetItem icon={Trash2} label="Delete message" destructive onPress={then(onDelete)} />
        </View>
      )}
    </Sheet>
  );
}

type MessageProps = {
  message: ChatMessage;
  repliedMessage: ChatMessage | null;
  grouped: boolean;
  onDelete: (messageId: string) => void | Promise<void>;
  // takes the message (the web closes over it) so rows can share one stable callback
  onReply: (message: ChatMessage) => void;
  // flash highlight when this is the message the route points at
  flash?: boolean;
  onFlashEnd?: () => void;
};

export const Message = memo(function Message({
  message,
  repliedMessage,
  grouped,
  onDelete,
  onReply,
  flash = false,
  onFlashEnd,
}: MessageProps) {
  const selfHandle = useSession((s) => s.user?.handle.toLowerCase());
  const editing = useChat((s) => s.editingMessage && s.editingMessageId === message.id);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // user ids are per server, so a message from a federated guild or DM carries the remote one
  const isMe = (author?: { username: string; server: string }) =>
    !!author && `@${author.username}:${author.server}`.toLowerCase() === selfHandle;
  const own = isMe(message.author);
  const authorName = message.author.displayName || message.author.username;
  const localOnly = !!message.ephemeral || !!message.thinking;
  const channelId = useChat((s) => selectActiveChannel(s)) ?? '';

  const inGuild = useChat((s) => s.route.kind === 'guild');
  const selfMentioned = useMemo(() => {
    if (!selfHandle || own) return false;
    if (inGuild && mentionsEveryone(message.content)) return true;

    const handles = [...(message.content.match(handlePattern) ?? []), ...message.pingedHandles];
    return isMe(repliedMessage?.author) || handles.some((h) => h.toLowerCase() === selfHandle);
  }, [message, repliedMessage, selfHandle, inGuild]);

  const viewable = useMemo(
    () => message.attachments.filter((a) => isImage(a) || isVideo(a) || isAudio(a) || isPdf(a)),
    [message.attachments]
  );
  const videos = message.attachments.filter(isVideo);
  const audios = message.attachments.filter(isAudio);
  const grid = message.attachments.filter((a) => !isVideo(a) && !isAudio(a));
  const singleImage = grid.length === 1 && isImage(grid[0]);

  const view = (attachment: Attachment) =>
    openAttachmentViewer({
      attachments: viewable,
      index: viewable.findIndex((item) => item.id === attachment.id),
      author: message.author,
      timestamp: message.timestamp,
    });

  const confirmDelete = () =>
    Alert.alert('Delete message?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await onDelete(message.id);
          } catch {
            toast('Could not delete the message', { tone: 'error' });
          }
        },
      },
    ]);

  const react = (emoji: string, add: boolean) =>
    chat()
      .react(channelId, message.id, emoji, add)
      .catch(() => toast('Could not react to the message', { tone: 'error' }));

  const openMenu = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMenuMounted(true);
    setMenuOpen(true);
  };

  // swipe left to reply (editing is in the long-press sheet: a second, further stage was too easy to hit by
  // accident). Right swipes are left alone so the stack's swipe back keeps working.
  const latest = useRef({ message, onReply, localOnly });
  latest.current = { message, onReply, localOnly };
  const reply = () => latest.current.onReply(latest.current.message);
  const translateX = useRef(new Animated.Value(0)).current;
  // the reply icon behind the row is an SVG, only worth mounting while a swipe is happening
  const [swiping, setSwiping] = useState(false);
  const swipe = useMemo(() => {
    // whether the swipe has gone far enough to reply
    let armed = false;
    const settle = () =>
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() =>
        setSwiping(false)
      );
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, { dx, dy }) =>
        !latest.current.localOnly && dx < -10 && Math.abs(dx) > Math.abs(dy) * 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        armed = false;
        setSwiping(true);
      },
      onPanResponderMove: (_event, { dx }) => {
        const x = Math.max(-SWIPE_MAX, Math.min(0, dx));
        translateX.setValue(x);
        const next = x <= -SWIPE_THRESHOLD;
        if (next === armed) return;
        if (next) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        armed = next;
      },
      onPanResponderRelease: () => {
        const { message, onReply } = latest.current;
        if (armed) onReply(message);
        settle();
      },
      onPanResponderTerminate: settle,
    });
  }, [translateX]);
  const hintOpacity = translateX.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View {...swipe.panHandlers} className={grouped ? 'mt-0.5' : 'mt-4'}>
      {swiping && (
        <Animated.View
          style={{ opacity: hintOpacity }}
          className="absolute inset-y-0 right-4 justify-center"
          pointerEvents="none"
        >
          <View className="size-9 items-center justify-center rounded-full bg-muted">
            <Icon as={Reply} size={20} className="text-foreground" />
          </View>
        </Animated.View>
      )}

      <Animated.View style={{ transform: [{ translateX }] }} className="bg-background">
        <Pressable
          accessibilityHint="Long press for message actions"
          accessibilityActions={[
            { name: 'reply', label: 'Reply' },
            { name: 'longpress', label: 'Message actions' },
          ]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'reply') reply();
            else openMenu();
          }}
          onLongPress={openMenu}
          delayLongPress={300}
          className={cn(
            'flex-row gap-3 px-3 py-0.5',
            selfMentioned && 'bg-amber-400/10',
            // the row stays lit while its action sheet is up or it is being edited, so it's clear which one it is
            (menuOpen || editing) && 'bg-muted/60'
          )}
        >
          {selfMentioned && (
            <View className="absolute inset-y-0 left-0 w-0.5 bg-amber-400" pointerEvents="none" />
          )}
          {flash && <Flash onEnd={onFlashEnd} />}

          {grouped ? (
            <View className="w-9 shrink-0" />
          ) : (
            <ProfileCard user={message.author} className="self-start">
              <Avatar
                src={message.author.avatarUrl}
                name={authorName}
                className={cn(message.interaction ? 'mt-5' : 'mt-0.5', 'size-9')}
                bgColor={message.author.avatarColor}
              />
            </ProfileCard>
          )}

          <View className="min-w-0 flex-1">
            {message.interaction && (
              <View className="mb-0.5 flex-row items-center gap-1">
                <Icon as={SquareSlash} size={12} className="text-primary/70" />
                <Text
                  className="shrink text-[11px] leading-4 text-muted-foreground"
                  numberOfLines={1}
                >
                  <Text className="text-[11px] font-medium text-foreground/75">
                    {message.interaction.user.displayName || message.interaction.user.username}
                  </Text>
                  {' used '}
                  <Text className="text-[11px] font-medium text-foreground/75">
                    /{message.interaction.name}
                  </Text>
                </Text>
              </View>
            )}
            {!grouped && (
              <View className="flex-row items-baseline gap-2">
                <ProfileCard user={message.author} className="shrink">
                  <Text className="text-base font-semibold" numberOfLines={1}>
                    {authorName}
                  </Text>
                </ProfileCard>
                {message.author.isBot && <BotBadge className="self-center" />}
                <Text className="text-xs text-muted-foreground">{stamp(message.timestamp)}</Text>
              </View>
            )}

            {message.replyTo && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Go to the replied message"
                onPress={() => goto(chat().messagePath(message.replyTo!))}
                hitSlop={{ top: 6, bottom: 6 }}
                className="mt-1 mb-0.5 min-h-8 max-w-full flex-row items-center gap-1.5 self-start border-l-2 border-primary/60 py-1 pr-2 pl-2 active:bg-muted/40"
              >
                <Icon as={Reply} size={14} className="text-muted-foreground" />
                {repliedMessage ? (
                  <>
                    <Text className="text-sm leading-5 font-medium text-foreground/90">
                      {repliedMessage.author.displayName || repliedMessage.author.username}
                    </Text>
                    <View className="min-w-0 shrink">
                      {repliedMessage.content ? (
                        <Markdown
                          content={repliedMessage.content}
                          inline
                          className="text-sm leading-5 text-muted-foreground"
                        />
                      ) : (
                        <Text className="text-sm leading-5 text-muted-foreground">
                          {repliedMessage.attachments.length} attachment
                          {repliedMessage.attachments.length === 1 ? '' : 's'}
                        </Text>
                      )}
                    </View>
                  </>
                ) : (
                  <Text className="text-sm leading-5 text-muted-foreground italic">
                    Original message unavailable
                  </Text>
                )}
              </Pressable>
            )}

            {message.content?.trim() || (message.edited && !message.embeds.length) ? (
              <Markdown
                content={message.content?.trim() ? message.content : ''}
                links
                className={bodyClass}
              >
                {message.edited && <Text className="text-xs text-muted-foreground"> (edited)</Text>}
              </Markdown>
            ) : null}

            {message.thinking && (
              <View className="flex-row items-center gap-1.5" accessibilityLiveRegion="polite">
                <Spinner />
                <Text className="text-sm text-muted-foreground">{authorName} is thinking…</Text>
              </View>
            )}
            {message.embeds.map((embed, index) => (
              <MessageEmbed key={index} embed={embed} />
            ))}
            {message.components.length > 0 && (
              <MessageComponents
                rows={message.components}
                channelId={channelId}
                messageId={message.id}
              />
            )}
            {message.ephemeral && !message.thinking && (
              <View className="mt-1 flex-row items-center gap-1.5">
                <Icon as={EyeOff} size={12} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">Only you can see this</Text>
                <Pressable
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={() => chat().removeMessage(channelId, message.id)}
                >
                  <Text className="text-xs text-link">Dismiss</Text>
                </Pressable>
              </View>
            )}

            {videos.map((attachment) => (
              // the same width as a single image, so a video doesn't take over the screen
              <View key={attachment.id} className="mt-2 max-w-[300px]">
                <VideoPlayer attachment={attachment} />
              </View>
            ))}
            {audios.map((attachment) => (
              <View key={attachment.id} className="mt-2 max-w-md">
                <AudioPlayer attachment={attachment} />
              </View>
            ))}
            {grid.length > 0 && (
              <View
                className={cn(
                  'mt-1.5 -mx-0.5 -mb-0.5 flex-row flex-wrap',
                  singleImage ? 'max-w-full' : 'max-w-80'
                )}
              >
                {grid.map((attachment) => (
                  <View
                    key={attachment.id}
                    // files get the full width so their names fit; images share rows of two
                    className={cn(
                      'p-0.5',
                      singleImage || !isImage(attachment) ? 'w-full' : 'w-1/2'
                    )}
                  >
                    {isImage(attachment) ? (
                      <ImageTile
                        attachment={attachment}
                        single={singleImage}
                        onPress={() => view(attachment)}
                      />
                    ) : (
                      <FileTile
                        attachment={attachment}
                        onPress={() =>
                          isPdf(attachment) ? view(attachment) : void openFileWith(attachment)
                        }
                      />
                    )}
                  </View>
                ))}
              </View>
            )}

            {message.reactions.length > 0 && !localOnly && (
              <Reactions
                reactions={message.reactions}
                onToggle={(reaction) => {
                  void Haptics.selectionAsync();
                  void react(reaction.emoji, !reaction.me);
                }}
                onAdd={() => setPickerOpen(true)}
              />
            )}
          </View>
        </Pressable>
      </Animated.View>

      {menuMounted && (
        <MessageMenu
          message={message}
          own={own}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onReply={reply}
          onReact={() => setPickerOpen(true)}
          onDelete={confirmDelete}
        />
      )}
      {/* mounted only while open, like the composer's: an always-mounted sheet per row is too heavy */}
      {pickerOpen && (
        <EmojiPicker
          open
          onClose={() => setPickerOpen(false)}
          onPick={(emoji) => react(emoji, true)}
        />
      )}
    </View>
  );
});
