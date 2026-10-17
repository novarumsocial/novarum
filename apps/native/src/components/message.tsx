// Port of apps/frontend/src/lib/components/message.svelte
// The hover toolbar and right-click menu become a long-press sheet, and swiping a row left replies.
// Rows stay cheap to mount (a channel opens with ~20 of them at once): the swipe is a JS PanResponder with a
// core Animated value instead of a native gesture handler and Reanimated hooks per row.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import {
  Copy,
  Download,
  FileText,
  IdCardLanyard,
  Link,
  Pencil,
  Reply,
  Trash2,
} from 'lucide-react-native';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Linking, PanResponder, Pressable, View } from 'react-native';
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { Avatar } from '@/components/avatar';
import { AudioPlayer } from '@/components/audio-player';
import { openAttachmentViewer } from '@/components/attachment-viewer';
import { EmojiText, handlePattern } from '@/components/emoji-text';
import { ProfileCard } from '@/components/profile-card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Textarea } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { VideoPlayer } from '@/components/video-player';
import { chat, useChat } from '@/lib/chat-state';
import { formatDate, formatTime } from '@/lib/format-date';
import { goto } from '@/lib/navigation';
import { useSession } from '@/lib/session';
import type { Attachment, Message as ChatMessage } from '@/lib/types/chat';
import { cn, formatBytes } from '@/lib/utils';

// where shared message links point (the same host the app opens as a deep link)
const webOrigin = 'https://app.novarum.me';
const SWIPE_THRESHOLD = 56;
const SWIPE_MAX = 80;
// your own messages swipe further, to edit them
const EDIT_THRESHOLD = 120;
const EDIT_MAX = 150;
const bodyClass = 'text-[15px] leading-[22px] text-foreground/90';

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
      accessibilityLabel={`${pdf ? 'View' : 'Download'} ${attachment.filename}`}
      onPress={onPress}
      className="min-h-11 w-full flex-row items-center gap-2 border border-input bg-background p-2 active:bg-accent"
    >
      <View className="size-9 items-center justify-center bg-muted">
        <Icon as={FileText} size={16} className="text-primary" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-xs font-medium" numberOfLines={1}>
          {attachment.filename}
        </Text>
        <Text className="font-mono text-[10px] uppercase text-muted-foreground">
          {pdf ? 'View' : formatBytes(attachment.size)}
        </Text>
      </View>
      {!pdf && <Icon as={Download} size={14} className="text-muted-foreground" />}
    </Pressable>
  );
}

// the inline editor the web shows in place of the message text
function EditBox({
  message,
  onEdit,
}: {
  message: ChatMessage;
  onEdit: (messageId: string, content: string | null) => void | Promise<void>;
}) {
  const [value, setValue] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const close = () => useChat.setState({ editingMessage: false });

  async function save() {
    if (saving) return;

    const next = value.trim();
    if (next === message.content) return close();

    setSaving(true);
    try {
      await onEdit(message.id, next || null);
      close();
    } catch {
      Alert.alert('Could not edit the message');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mt-1 gap-2">
      <Textarea
        autoFocus
        value={value}
        onChangeText={setValue}
        className="min-h-20"
        accessibilityLabel="Edit message"
      />
      <View className="flex-row gap-2">
        <Button onPress={save} disabled={saving}>
          <Text>{saving ? 'Saving...' : 'Save'}</Text>
        </Button>
        <Button variant="ghost" onPress={close}>
          <Text>Cancel</Text>
        </Button>
      </View>
    </View>
  );
}

function MessageMenu({
  message,
  own,
  open,
  onClose,
  onReply,
  onDelete,
}: {
  message: ChatMessage;
  own: boolean;
  open: boolean;
  onClose: () => void;
  onReply: () => void;
  onDelete: () => void;
}) {
  // run the action once the sheet has started closing
  const then = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <Sheet open={open} onClose={onClose}>
      {/* grouped messages hide their time, so the sheet always says who sent it and when */}
      <Text className="px-4 pt-2 pb-1 text-xs text-muted-foreground" numberOfLines={1}>
        <Text className="text-xs font-medium">
          {message.author.displayName || message.author.username}
        </Text>
        {` · ${formatDate(message.timestamp)} at ${formatTime(message.timestamp)}`}
      </Text>
      <SheetItem icon={Reply} label="Reply" onPress={then(onReply)} />
      {own && (
        <SheetItem
          icon={Pencil}
          label="Edit Message"
          onPress={then(() =>
            useChat.setState({ editingMessage: true, editingMessageId: message.id })
          )}
        />
      )}
      <SheetItem
        icon={Copy}
        label="Copy Text"
        onPress={then(() => void Clipboard.setStringAsync(message.content ?? ''))}
      />
      <SheetItem
        icon={Link}
        label="Copy Message Link"
        onPress={then(
          () => void Clipboard.setStringAsync(`${webOrigin}${chat().messagePath(message.id)}`)
        )}
      />
      <SheetItem
        icon={IdCardLanyard}
        label="Copy Message ID"
        onPress={then(() => void Clipboard.setStringAsync(message.id))}
      />
      {own && <SheetItem icon={Trash2} label="Delete" destructive onPress={then(onDelete)} />}
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
  onEdit: (messageId: string, content: string | null) => void | Promise<void>;
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
  onEdit,
  flash = false,
  onFlashEnd,
}: MessageProps) {
  const selfHandle = useSession((s) => s.user?.handle.toLowerCase());
  const editing = useChat((s) => s.editingMessage && s.editingMessageId === message.id);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // user ids are per server, so a message from a federated guild or DM carries the remote one
  const isMe = (author?: { username: string; server: string }) =>
    !!author && `@${author.username}:${author.server}`.toLowerCase() === selfHandle;
  const own = isMe(message.author);
  const authorName = message.author.displayName || message.author.username;

  const selfMentioned = useMemo(() => {
    if (!selfHandle || own) return false;

    const handles = [...(message.content.match(handlePattern) ?? []), ...message.pingedHandles];
    return isMe(repliedMessage?.author) || handles.some((h) => h.toLowerCase() === selfHandle);
  }, [message, repliedMessage, selfHandle]);

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
            Alert.alert('Could not delete the message');
          }
        },
      },
    ]);

  const openMenu = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMenuMounted(true);
    setMenuOpen(true);
  };

  // swipe left a bit to reply, or further on your own message to edit it. Right swipes are left alone so the
  // stack's swipe back keeps working.
  const latest = useRef({ message, onReply, own });
  latest.current = { message, onReply, own };
  const reply = () => latest.current.onReply(latest.current.message);
  const translateX = useRef(new Animated.Value(0)).current;
  // the reply icon behind the row is an SVG, only worth mounting while a swipe is happening
  const [swiping, setSwiping] = useState(false);
  const [swipeEdits, setSwipeEdits] = useState(false);
  const swipe = useMemo(() => {
    // how far the swipe has gone: 0 nothing, 1 reply, 2 edit
    let stage = 0;
    const settle = () =>
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() =>
        setSwiping(false)
      );
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, { dx, dy }) =>
        dx < -10 && Math.abs(dx) > Math.abs(dy) * 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        stage = 0;
        setSwiping(true);
        setSwipeEdits(false);
      },
      onPanResponderMove: (_event, { dx }) => {
        const x = Math.max(-(latest.current.own ? EDIT_MAX : SWIPE_MAX), Math.min(0, dx));
        translateX.setValue(x);
        const next = x <= -EDIT_THRESHOLD ? 2 : x <= -SWIPE_THRESHOLD ? 1 : 0;
        if (next === stage) return;
        if (next > stage) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        stage = next;
        setSwipeEdits(stage === 2);
      },
      onPanResponderRelease: () => {
        const { message, onReply } = latest.current;
        if (stage === 2) useChat.setState({ editingMessage: true, editingMessageId: message.id });
        else if (stage === 1) onReply(message);
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
          <Icon as={swipeEdits ? Pencil : Reply} size={20} className="text-muted-foreground" />
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
            // the row stays lit while its action sheet is up, so it's clear which message it's for
            menuOpen && 'bg-muted/60'
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
                className="mt-0.5 size-9"
                bgColor={message.author.avatarColor}
              />
            </ProfileCard>
          )}

          <View className="min-w-0 flex-1">
            {!grouped && (
              <View className="flex-row items-baseline gap-2">
                <ProfileCard user={message.author} className="shrink">
                  <Text className="text-sm font-semibold" numberOfLines={1}>
                    {authorName}
                  </Text>
                </ProfileCard>
                <Text className="text-[11px] text-muted-foreground">
                  {formatTime(message.timestamp)}
                </Text>
              </View>
            )}

            {message.replyTo && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Go to the replied message"
                onPress={() => goto(chat().messagePath(message.replyTo!))}
                className="mt-0.5 min-h-5 flex-row items-start gap-1 self-start border-l-2 border-primary/40 pl-1.5 active:bg-muted/40"
              >
                <Icon as={Reply} size={12} className="mt-0.5 text-primary/60" />
                {repliedMessage ? (
                  <>
                    <Text className="text-[11px] font-medium leading-4 text-foreground/75">
                      {repliedMessage.author.displayName || repliedMessage.author.username}
                    </Text>
                    <Text className="text-[11px] leading-4 text-muted-foreground/40">·</Text>
                    <View className="min-w-0 shrink">
                      {repliedMessage.content ? (
                        <EmojiText
                          content={repliedMessage.content}
                          className="text-[11px] leading-4 text-muted-foreground"
                        />
                      ) : (
                        <Text className="text-[11px] leading-4 text-muted-foreground">
                          {repliedMessage.attachments.length} attachment
                          {repliedMessage.attachments.length === 1 ? '' : 's'}
                        </Text>
                      )}
                    </View>
                  </>
                ) : (
                  <Text className="text-[11px] italic leading-4 text-muted-foreground/70">
                    Original message unavailable
                  </Text>
                )}
              </Pressable>
            )}

            {editing ? (
              <EditBox message={message} onEdit={onEdit} />
            ) : message.content?.trim() || message.edited ? (
              <EmojiText content={message.content ?? ''} links className={bodyClass}>
                {message.edited && (
                  <Text className="text-[11px] text-muted-foreground/60">
                    {' '}
                    (edited
                    {message.editedTime
                      ? ` ${formatDate(new Date(message.editedTime))} at ${formatTime(new Date(message.editedTime))}`
                      : ''}
                    )
                  </Text>
                )}
              </EmojiText>
            ) : null}

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
                    className={cn('p-0.5', singleImage ? 'w-full' : 'w-1/2')}
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
                          isPdf(attachment)
                            ? view(attachment)
                            : void Linking.openURL(attachment.url)
                        }
                      />
                    )}
                  </View>
                ))}
              </View>
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
          onDelete={confirmDelete}
        />
      )}
    </View>
  );
});
