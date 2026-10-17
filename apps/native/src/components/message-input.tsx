// Port of apps/frontend/src/lib/components/message-input.svelte
// A multiline composer with a send button, attachments from the camera / gallery / files, and mention and
// emoji suggestions shown as a strip above the keyboard.
import { File } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Camera, FileText, Files, ImageIcon, Paperclip, Send, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Textarea } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { useAnchor } from '@/lib/anchor';
import { useChat, type PickedFile } from '@/lib/chat-state';
import { realtime, useRealtime } from '@/lib/realtime';
import type { Author } from '@/lib/types/chat';
import { cn, formatBytes } from '@/lib/utils';

const maxFiles = 5;

// both pickers return slightly different shapes; this turns either into a PickedFile
const pickedSchema = z
  .object({
    uri: z.string(),
    name: z.string().optional(),
    fileName: z.string().nullish(),
    mimeType: z.string().optional(),
    type: z.string().nullish(),
    size: z.number().optional(),
    fileSize: z.number().optional(),
  })
  .transform(
    (asset): PickedFile => ({
      uri: asset.uri,
      name: asset.name ?? asset.fileName ?? asset.uri.split('/').pop() ?? 'file',
      mimeType:
        asset.mimeType ??
        (asset.type === 'video'
          ? 'video/mp4'
          : asset.type === 'image'
            ? 'image/jpeg'
            : 'application/octet-stream'),
      size: asset.size ?? asset.fileSize ?? new File(asset.uri).size,
    })
  );

const memberHandle = (member: Author) => `${member.username}:${member.server}`;

// the `@query` or `:query` right before the cursor, like the web's regexes
function findSearch(text: string, cursor: number) {
  const before = text.slice(0, cursor);
  const mention = before.match(/(?:^|\s)@([a-zA-Z0-9._:-]*)$/);
  if (mention) {
    return { kind: 'mention' as const, query: mention[1], start: cursor - mention[1].length - 1 };
  }

  const emoji = before.match(/(?:^|\s):([\w+-]*)$/);
  if (emoji)
    return { kind: 'emoji' as const, query: emoji[1], start: cursor - emoji[1].length - 1 };

  return null;
}

type EmojiResult = ReturnType<typeof useRealtime.getState>['emojiResults'][number];

export function MessageInput({
  placeholder = 'Send a message',
  onSend = () => {},
  onTyping = () => {},
  focusOn = null,
}: {
  placeholder?: string;
  // the chat shows the message as "sending" right away; this only throws when it could not even take it
  onSend?: (content: string | null, files: PickedFile[]) => void | Promise<void>;
  onTyping?: () => void;
  // focus the input whenever this changes to something (chat-area passes the id of the message being replied to)
  focusOn?: string | null;
}) {
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const input = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((s) => s.isVisible);
  const maxFileSize = useAnchor((s) => s.maxFileSize) * 1024 * 1024;
  const members = useChat((s) => s.members);
  const uploadProgress = useChat((s) => s.uploadProgress);
  const emojiQuery = useRealtime((s) => s.emojiQuery);
  const emojiResults = useRealtime((s) => s.emojiResults);

  const search = useMemo(
    () => findSearch(content, Math.min(selection.start, content.length)),
    [content, selection.start]
  );
  const mentionResults = useMemo(() => {
    if (search?.kind !== 'mention') return [];
    const query = search.query.toLowerCase();
    return members
      .filter((member) =>
        [member.username, member.displayName ?? '', memberHandle(member)].some((value) =>
          value.toLowerCase().includes(query)
        )
      )
      .slice(0, 8);
  }, [members, search]);
  const emojiMatches =
    search?.kind === 'emoji' && emojiQuery.trim() === search.query.trim() ? emojiResults : [];

  const emojiSearch = search?.kind === 'emoji' ? search.query : null;
  useEffect(() => {
    if (emojiSearch !== null) realtime().searchEmojis(emojiSearch);
  }, [emojiSearch]);

  useEffect(() => {
    if (focusOn) input.current?.focus();
  }, [focusOn]);

  async function handleSend() {
    const trimmed = content.trim() || null;
    if ((!trimmed && files.length === 0) || sending) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const draft = content;
    setSending(true);
    setSendError('');
    // optimistic: the chat shows the message as "sending" (with a retry if it fails), so the composer clears now
    // and only gets the text back if the chat could not even take it
    setContent('');
    try {
      await onSend(trimmed, files);
      setFiles([]);
    } catch (error) {
      setContent(draft);
      setSendError(error instanceof Error ? error.message : 'Could not send message');
    } finally {
      setSending(false);
    }
  }

  function addFiles(next: PickedFile[]) {
    setSendError('');
    const existing = new Set(files.map((file) => `${file.name}:${file.size}`));
    const unique = next.filter((file) => !existing.has(`${file.name}:${file.size}`));
    const oversized = unique.find((file) => file.size > maxFileSize);

    if (oversized) {
      setSendError(`${oversized.name} exceeds the ${useAnchor.getState().maxFileSize} MB limit.`);
      return;
    }

    if (files.length + unique.length > maxFiles) {
      setSendError(`You can attach up to ${maxFiles} files at once.`);
      return;
    }

    setFiles([...files, ...unique]);
  }

  async function pick(source: 'camera' | 'library' | 'files') {
    // the sheet stays up until the picker returns: launching an activity mid-dismiss can swallow it
    try {
      if (source === 'files') {
        const result = await DocumentPicker.getDocumentAsync({
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (!result.canceled) addFiles(z.array(pickedSchema).parse(result.assets));
        return;
      }

      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted)
          return setSendError('Allow camera access in Settings to take photos.');
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'] })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images', 'videos'],
              allowsMultipleSelection: true,
              selectionLimit: Math.max(1, maxFiles - files.length),
            });
      if (!result.canceled) addFiles(z.array(pickedSchema).parse(result.assets));
    } catch (error) {
      console.error('Attachment picker failed', error);
      setSendError('Could not read that file.');
    } finally {
      setAttachOpen(false);
    }
  }

  // swap the `@query` / `:query` for the chosen text
  function replaceSearch(text: string) {
    if (!search) return;

    const cursor = Math.min(selection.start, content.length);
    const next = `${content.slice(0, search.start)}${text} ${content.slice(cursor)}`;
    const nextCursor = search.start + text.length + 1;
    setContent(next);
    setSelection({ start: nextCursor, end: nextCursor });
  }

  const insertMention = (member: Author) => replaceSearch(`@${memberHandle(member)}`);
  const insertEmoji = (emoji: EmojiResult) =>
    replaceSearch(
      String.fromCodePoint(...emoji.unicode.split('-').map((part) => parseInt(part, 16)))
    );

  const canSend = (content.trim().length > 0 || files.length > 0) && !sending;

  return (
    <View
      className="border-t border-border bg-background p-2"
      style={{ paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 8) }}
    >
      {(mentionResults.length > 0 || emojiMatches.length > 0) && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          className="mb-2 max-h-11 border border-border bg-popover"
        >
          {mentionResults.map((member) => (
            <Pressable
              accessibilityRole="button"
              key={member.userId}
              onPress={() => insertMention(member)}
              className="h-11 flex-row items-center gap-2 px-3 active:bg-accent"
            >
              <Avatar
                src={member.avatarUrl}
                name={member.displayName || member.username}
                bgColor={member.avatarColor}
                className="size-6"
              />
              <Text className="text-xs font-medium">{member.displayName || member.username}</Text>
              <Text className="font-mono text-[10px] text-muted-foreground">
                @{memberHandle(member)}
              </Text>
            </Pressable>
          ))}
          {emojiMatches.map((emoji) => (
            <Pressable
              accessibilityRole="button"
              key={emoji.unicode}
              onPress={() => insertEmoji(emoji)}
              className="h-11 flex-row items-center gap-2 px-3 active:bg-accent"
            >
              <Image
                source={{ uri: emoji.url }}
                contentFit="contain"
                style={{ width: 22, height: 22 }}
              />
              <Text className="text-xs">:{emoji.name.toLowerCase().replaceAll(' ', '_')}:</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {files.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
          <View className="flex-row gap-2">
            {files.map((file, index) => {
              const progress = uploadProgress[index];
              return (
                <View
                  key={file.uri}
                  className="size-24 overflow-hidden border border-border bg-muted/30"
                >
                  {file.mimeType.startsWith('image/') ? (
                    <Image
                      source={{ uri: file.uri }}
                      contentFit="cover"
                      style={{
                        width: '100%',
                        height: '100%',
                        opacity: progress === undefined ? 1 : 0.6,
                      }}
                    />
                  ) : (
                    <View className="flex-1 items-center justify-center gap-1.5 px-2 pb-4">
                      <Icon as={FileText} size={20} className="text-primary" />
                      <Text
                        className="w-full text-center text-[11px] font-medium"
                        numberOfLines={1}
                      >
                        {file.name}
                      </Text>
                    </View>
                  )}
                  <View className="absolute bottom-1 left-1 bg-background/80 px-1 py-px">
                    <Text className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                      {formatBytes(file.size)}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${file.name}`}
                    disabled={sending}
                    hitSlop={10}
                    onPress={() => setFiles(files.filter((item) => item !== file))}
                    className={cn(
                      'absolute top-1 right-1 size-7 items-center justify-center bg-background/80',
                      sending && 'opacity-40'
                    )}
                  >
                    <Icon as={X} size={14} />
                  </Pressable>
                  {progress !== undefined && (
                    <View
                      className="absolute bottom-0 left-0 h-0.5 bg-primary"
                      style={{ width: `${progress * 100}%` }}
                    />
                  )}
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}

      {sendError ? (
        <Text className="mb-2 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {sendError}
        </Text>
      ) : null}

      <View
        className={cn(
          'flex-row items-end gap-1 border bg-background p-1',
          focused ? 'border-primary/50' : 'border-border'
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel="Add attachments"
          onPress={() => setAttachOpen(true)}
        >
          <Icon as={Paperclip} size={18} className="text-muted-foreground" />
        </Button>
        <Textarea
          ref={input}
          value={content}
          onChangeText={(text) => {
            setContent(text);
            if (text.trim()) onTyping();
          }}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          accessibilityLabel={placeholder}
          className="max-h-40 min-h-11 flex-1 border-0 bg-transparent px-1 py-2.5 text-[15px]"
        />
        <Button
          size="icon"
          disabled={!canSend}
          accessibilityLabel="Send message"
          onPress={handleSend}
        >
          <Icon as={Send} size={18} className="text-primary-foreground" />
        </Button>
      </View>

      {/* mounted only while open: an always-mounted sheet in the composer never presented */}
      {attachOpen && (
        <Sheet open onClose={() => setAttachOpen(false)}>
          <SheetItem icon={Camera} label="Camera" onPress={() => void pick('camera')} />
          <SheetItem icon={ImageIcon} label="Photo library" onPress={() => void pick('library')} />
          <SheetItem icon={Files} label="Files" onPress={() => void pick('files')} />
        </Sheet>
      )}
    </View>
  );
}
