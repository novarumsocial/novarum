// Port of apps/frontend/src/lib/components/message-input.svelte
// A multiline composer with a send button, attachments from the camera / gallery / files, and mention and
// emoji suggestions shown as a strip above the keyboard.
import { File } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import {
  Camera,
  FileText,
  Files,
  ImageIcon,
  Paperclip,
  SendHorizontal,
  X,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';
import { Avatar } from '@/components/avatar';
import { CommandForm } from '@/components/command-form';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Textarea } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { SheetItem } from '@/components/ui/sheet-item';
import { Text } from '@/components/ui/text';
import { useAnchor } from '@/lib/anchor';
import {
  maxMessageLength,
  selectActiveChannel,
  selectActiveServer,
  useChat,
  type PickedFile,
} from '@/lib/chat-state';
import { interactions, useGuildCommands, type GuildBotCommands } from '@/lib/bots';
import type { Command } from 'anchor/bot-schemas';
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
  context,
}: {
  placeholder?: string;
  // the chat shows the message as "sending" right away; this only throws when it could not even take it
  onSend?: (content: string | null, files: PickedFile[]) => void | Promise<void>;
  onTyping?: () => void;
  // focus the input whenever this changes to something (chat-area passes the id of the message being replied to)
  focusOn?: string | null;
  // a row above the text, inside the composer (what you are replying to)
  context?: ReactNode;
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
  const inGuild = useChat((s) => s.route.kind === 'guild');
  const uploadProgress = useChat((s) => s.uploadProgress);
  const activeServer = useChat((s) => selectActiveServer(s));
  const activeChannel = useChat((s) => selectActiveChannel(s));
  const guildCommands = useGuildCommands(activeServer);
  const [activeCommand, setActiveCommand] = useState<{
    entry: GuildBotCommands;
    command: Command;
  } | null>(null);
  const emojiQuery = useRealtime((s) => s.emojiQuery);
  const emojiResults = useRealtime((s) => s.emojiResults);

  const search = useMemo(
    () => findSearch(content, Math.min(selection.start, content.length)),
    [content, selection.start]
  );
  const mentionResults = useMemo(() => {
    if (search?.kind !== 'mention') return [];
    const query = search.query.toLowerCase();
    const everyone =
      inGuild && 'everyone'.startsWith(query)
        ? [{ id: 'everyone', name: 'Everyone', handle: 'everyone', member: null }]
        : [];
    const matches = members
      .filter((member) =>
        [member.username, member.displayName ?? '', memberHandle(member)].some((value) =>
          value.toLowerCase().includes(query)
        )
      )
      .map((member) => ({
        id: member.userId,
        name: member.displayName || member.username,
        handle: memberHandle(member),
        member,
      }));
    return [...everyone, ...matches].slice(0, 8);
  }, [members, search, inGuild]);
  // "/name" with nothing after it, in a guild: the person is picking a slash command
  const commandQuery =
    inGuild && /^\/[\w-]*$/.test(content) ? content.slice(1).toLowerCase() : null;
  const commandResults = useMemo(
    () =>
      commandQuery === null
        ? []
        : guildCommands
            .flatMap((entry) => entry.commands.map((command) => ({ entry, command })))
            .filter(({ command }) => command.name.startsWith(commandQuery))
            .slice(0, 10),
    [commandQuery, guildCommands]
  );
  const pickingCommand = commandQuery !== null;
  useEffect(() => {
    if (pickingCommand && activeServer) void interactions().loadCommands(activeServer);
  }, [pickingCommand, activeServer]);

  async function pickCommand(result: { entry: GuildBotCommands; command: Command }) {
    setContent('');
    // nothing to fill in: run it right away, like sending a message
    if (!result.command.options?.length && activeChannel) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setSendError('');
      const failed = await interactions().runCommand(
        activeChannel,
        result.entry,
        result.command.name,
        []
      );
      setSendError(failed ?? '');
      return;
    }
    input.current?.blur();
    setActiveCommand(result);
  }

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

  const insertMention = (handle: string) => replaceSearch(`@${handle}`);
  const insertEmoji = (emoji: EmojiResult) =>
    replaceSearch(
      String.fromCodePoint(...emoji.unicode.split('-').map((part) => parseInt(part, 16)))
    );

  const canSend = (content.trim().length > 0 || files.length > 0) && !sending;
  // only shown once the limit is close, so it never competes with the message itself
  const remaining = maxMessageLength - content.length;

  return (
    <View
      className="bg-background px-2 pt-1"
      style={{ paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 8) }}
    >
      {commandResults.length > 0 && (
        <ScrollView
          keyboardShouldPersistTaps="always"
          className="mb-2 max-h-64 border border-border bg-popover"
        >
          {commandResults.map((result) => (
            <Pressable
              accessibilityRole="button"
              key={`${result.entry.bot.userId}:${result.command.name}`}
              onPress={() => void pickCommand(result)}
              className="min-h-12 flex-row items-center gap-2.5 px-3 active:bg-accent"
            >
              <Avatar
                src={result.entry.bot.avatarUrl}
                name={result.entry.bot.displayName || result.entry.bot.username}
                bgColor={result.entry.bot.avatarColor}
                className="size-6"
              />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold">/{result.command.name}</Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {result.command.description}
                </Text>
              </View>
              <Text className="text-[11px] text-muted-foreground">
                {result.entry.bot.displayName || result.entry.bot.username}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {(mentionResults.length > 0 || emojiMatches.length > 0) && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          className="mb-2 max-h-11 border border-border bg-popover"
        >
          {mentionResults.map((result) => (
            <Pressable
              accessibilityRole="button"
              key={result.id}
              onPress={() => insertMention(result.handle)}
              className="h-11 flex-row items-center gap-2 px-3 active:bg-accent"
            >
              {result.member && (
                <Avatar
                  src={result.member.avatarUrl}
                  name={result.name}
                  bgColor={result.member.avatarColor}
                  className="size-6"
                />
              )}
              <Text className="text-xs font-medium">{result.name}</Text>
              <Text className="font-mono text-[10px] text-muted-foreground">@{result.handle}</Text>
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

      <View className={cn('border bg-card', focused ? 'border-primary/60' : 'border-border')}>
        {context ? <View className="border-b border-border/60">{context}</View> : null}
        {files.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="border-b border-border/60"
            contentContainerClassName="p-2"
          >
            <View className="flex-row gap-2">
              {files.map((file, index) => {
                const progress = uploadProgress[index];
                return (
                  <View
                    key={file.uri}
                    className="size-20 overflow-hidden border border-border bg-background"
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
                      <Text className="text-[10px] text-muted-foreground">
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
          <Text className="border-b border-border/60 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {sendError}
          </Text>
        ) : null}
        {activeCommand && activeChannel && (
          <CommandForm
            entry={activeCommand.entry}
            command={activeCommand.command}
            channelId={activeChannel}
            onClose={() => setActiveCommand(null)}
          />
        )}
        <View className={cn('flex-row items-end gap-1 p-1', activeCommand && 'hidden')}>
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
            maxLength={maxMessageLength}
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
          {remaining <= 200 && (
            <Text
              className={cn(
                'h-11 px-1 text-xs leading-[44px]',
                remaining <= 0
                  ? 'text-destructive'
                  : remaining <= 50
                    ? 'text-amber-500'
                    : 'text-muted-foreground'
              )}
              accessibilityLabel={`${remaining} characters left`}
            >
              {remaining}
            </Text>
          )}
          <Button
            size="icon"
            variant={canSend ? 'default' : 'ghost'}
            disabled={!canSend}
            accessibilityLabel="Send message"
            onPress={handleSend}
          >
            <Icon
              as={SendHorizontal}
              size={18}
              className={canSend ? 'text-primary-foreground' : 'text-muted-foreground'}
            />
          </Button>
        </View>
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
