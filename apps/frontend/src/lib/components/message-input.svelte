<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { realtime } from '$lib/realtime.svelte';
  import { FileText, Paperclip, SendHorizontal, X } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';
  import { chat, maxMessageLength } from '$lib/chat-state.svelte';
  import { anchor } from '$lib/anchor.svelte';
  import type { Author } from '$lib/types/chat';
  import { device } from '$lib/device.svelte';
  import { isSelf } from '$lib/session.svelte';
  import { formatBytes } from '$lib/utils';
  import { interactions, type GuildBotCommands } from '$lib/bots.svelte';
  import type { Command } from 'anchor/bot-schemas';
  import CommandForm from './command-form.svelte';
  import Avatar from './avatar.svelte';

  let content = $state('');
  let files = $state<File[]>([]);
  let fileInput: HTMLInputElement;
  let textarea: HTMLTextAreaElement;
  let sending = $state(false);
  let sendError = $state('');
  let dragDepth = $state(0);
  let draggingFiles = $state(false);
  let emojiQuery = $state('');
  let emojiStart = $state<number | null>(null);
  let selectedEmoji = $state(0);
  let mentionQuery = $state('');
  let mentionStart = $state<number | null>(null);
  let selectedMention = $state(0);
  let selectedCommand = $state(0);
  let activeCommand = $state<{ entry: GuildBotCommands; command: Command } | null>(null);
  // "/name" with nothing after it, in a guild: the person is picking a slash command
  const commandQuery = $derived(
    chat.activeServer && /^\/[\w-]*$/.test(content) ? content.slice(1).toLowerCase() : null
  );
  const commandResults = $derived(
    commandQuery === null
      ? []
      : interactions
          .commandsFor(chat.activeServer)
          .flatMap((entry) => entry.commands.map((command) => ({ entry, command })))
          .filter(({ command }) => command.name.startsWith(commandQuery))
          .slice(0, 10)
  );
  $effect(() => {
    if (commandQuery !== null && chat.activeServer)
      void interactions.loadCommands(chat.activeServer);
  });

  async function pickCommand(result: { entry: GuildBotCommands; command: Command }) {
    content = '';
    selectedCommand = 0;
    // nothing to fill in: run it right away, like sending a message
    if (!result.command.options?.length && chat.activeChannel) {
      sendError = '';
      sendError =
        (await interactions.runCommand(
          chat.activeChannel,
          result.entry,
          result.command.name,
          []
        )) ?? '';
      return;
    }
    activeCommand = result;
  }

  function closeCommand() {
    activeCommand = null;
    requestAnimationFrame(() => textarea?.focus());
  }

  const emojiResults = $derived(
    realtime.emojiQuery.trim() === emojiQuery.trim() ? realtime.emojiResults : []
  );
  const mentionResults = $derived.by(() => {
    if (mentionStart === null) return [];
    const query = mentionQuery.toLowerCase();
    const everyone =
      chat.route.kind === 'guild' && 'everyone'.startsWith(query)
        ? [{ id: 'everyone', name: 'Everyone', handle: 'everyone' }]
        : [];
    const members = chat.members
      .filter((member) =>
        [member.username, member.displayName ?? '', memberHandle(member)].some((value) =>
          value.toLowerCase().includes(query)
        )
      )
      .map((member) => ({
        id: member.userId,
        name: member.displayName || member.username,
        handle: memberHandle(member),
      }));
    return [...everyone, ...members].slice(0, 8);
  });
  const previews = $derived(
    files.map((file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null))
  );
  $effect(() => {
    const urls = previews;
    return () => urls.forEach((url) => url && URL.revokeObjectURL(url));
  });
  const maxFiles = 5;
  const maxFileSize = $derived(anchor.maxFileSize * 1024 * 1024);
  let {
    placeholder = 'Send a message',
    onSend = () => {},
    onTyping = () => {},
    context,
  }: {
    placeholder?: string;
    onSend?: (content: string | null, files: File[]) => void | Promise<void>;
    onTyping?: () => void;
    // a row above the text, inside the composer (what you are replying to)
    context?: Snippet;
  } = $props();

  const canSend = $derived((!!content.trim() || files.length > 0) && !sending);
  // only shown once the limit is close, so it never competes with the message itself
  const remaining = $derived(maxMessageLength - content.length);

  async function handleSend() {
    const trimmed = content.trim() || null;
    if ((!trimmed && files.length === 0) || sending) return;

    sending = true;
    sendError = '';
    try {
      await onSend(trimmed, files);
      content = '';
      files = [];
      closeEmojiSearch();
      closeMentionSearch();
    } catch (error) {
      sendError = error instanceof Error ? error.message : 'Could not send message';
    } finally {
      sending = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (commandResults.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectedCommand =
          (selectedCommand + (e.key === 'ArrowDown' ? 1 : -1) + commandResults.length) %
          commandResults.length;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickCommand(commandResults[selectedCommand] ?? commandResults[0]!);
        return;
      }
    }

    if (mentionStart !== null && mentionResults.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectedMention =
          (selectedMention + (e.key === 'ArrowDown' ? 1 : -1) + mentionResults.length) %
          mentionResults.length;
        return;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionResults[selectedMention]!.handle);
        return;
      }
    }

    if (emojiStart !== null && emojiResults.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectedEmoji =
          (selectedEmoji + (e.key === 'ArrowDown' ? 1 : -1) + emojiResults.length) %
          emojiResults.length;
        return;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertEmoji(emojiResults[selectedEmoji]!);
        return;
      }
    }

    if (e.key === 'Escape' && (emojiStart !== null || mentionStart !== null)) {
      e.preventDefault();
      closeEmojiSearch();
      closeMentionSearch();
      return;
    }

    if (e.key === 'ArrowUp' && !content && files.length === 0) {
      const lastOwn = chat.currentMessages.findLast((message) => isSelf(message.author));
      if (lastOwn) {
        e.preventDefault();
        chat.editingMessage = true;
        chat.editingMessageId = lastOwn.id;
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (content.trim() || e.key.length === 1) onTyping();
  }

  function updateSearch() {
    const cursor = textarea.selectionStart;
    const mentionMatch = textarea.value.slice(0, cursor).match(/(?:^|\s)@([a-zA-Z0-9._:-]*)$/);
    if (mentionMatch) {
      mentionQuery = mentionMatch[1] ?? '';
      mentionStart = cursor - mentionQuery.length - 1;
      selectedMention = 0;
      closeEmojiSearch();
      return;
    }
    closeMentionSearch();

    const match = textarea.value.slice(0, cursor).match(/(?:^|\s):([\w+-]*)$/);
    if (!match) {
      closeEmojiSearch();
      return;
    }

    emojiQuery = match[1] ?? '';
    emojiStart = cursor - emojiQuery.length - 1;
    selectedEmoji = 0;
    realtime.searchEmojis(emojiQuery);
  }

  function handleKeyup(e: KeyboardEvent) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateSearch();
  }

  function closeEmojiSearch() {
    emojiStart = null;
    emojiQuery = '';
  }

  function closeMentionSearch() {
    mentionStart = null;
    mentionQuery = '';
  }

  function memberHandle(member: Author) {
    return `${member.username}:${member.server}`;
  }

  $effect(() => {
    const member = chat.mentionRequest;
    if (!member) return;
    chat.mentionRequest = null;
    const mention = `@${memberHandle(member)} `;
    content = content ? `${content.trimEnd()} ${mention}` : mention;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(content.length, content.length);
    });
  });

  function insertMention(handle: string) {
    if (mentionStart === null) return;

    const cursor = textarea.selectionStart;
    const mention = `@${handle}`;
    const nextCursor = mentionStart + mention.length + 1;
    content = `${content.slice(0, mentionStart)}${mention} ${content.slice(cursor)}`;
    closeMentionSearch();
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function insertEmoji(emoji: (typeof realtime.emojiResults)[number]) {
    if (emojiStart === null) return;

    const cursor = textarea.selectionStart;
    const glyph = String.fromCodePoint(
      ...emoji.unicode.split('-').map((part) => parseInt(part, 16))
    );
    const nextCursor = emojiStart + glyph.length + 1;
    content = `${content.slice(0, emojiStart)}${glyph} ${content.slice(cursor)}`;
    closeEmojiSearch();
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function fileKey(file: File) {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  function addFiles(nextFiles: File[]) {
    sendError = '';
    const existing = new Set(files.map(fileKey));
    const unique = nextFiles.filter((file) => !existing.has(fileKey(file)));
    const oversized = unique.find((file) => file.size > maxFileSize);

    if (oversized) {
      sendError = `${oversized.name} exceeds the ${anchor.maxFileSize} MB limit.`;
      return;
    }

    if (files.length + unique.length > maxFiles) {
      sendError = `You can attach up to ${maxFiles} files at once.`;
      return;
    }

    files = [...files, ...unique];
  }

  function handleFileInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    addFiles(Array.from(input.files ?? []));
    input.value = '';
  }

  function hasDraggedFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  function handleDragEnter(event: DragEvent) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    draggingFiles = true;
  }

  function handleDragLeave(event: DragEvent) {
    if (!draggingFiles) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) draggingFiles = false;
  }

  function handleDrop(event: DragEvent) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    draggingFiles = false;
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  function windowKeyDown(event: KeyboardEvent) {
    // typing into another field (like the canvas editor) stays there
    const otherField = (event.target as HTMLElement).closest?.(
      'input, textarea, [contenteditable]'
    );
    if (
      !otherField &&
      textarea !== document.activeElement &&
      !event.ctrlKey &&
      !event.metaKey &&
      !chat.editingMessage
    ) {
      textarea.focus();
    }
  }

  function handlePaste(event: ClipboardEvent) {
    const target = event.target as HTMLElement;
    const otherField = target.closest?.('input, textarea, [contenteditable], [role="dialog"]');
    if (target !== textarea && otherField) return;
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  }
</script>

<svelte:window onkeydown={windowKeyDown} onpaste={handlePaste} />

<div
  class="relative px-2 pb-2 sm:px-4 sm:pb-4 @2xl:pl-52"
  role="group"
  aria-label="Message composer"
  ondragenter={handleDragEnter}
  ondragover={(event) => {
    if (hasDraggedFiles(event)) event.preventDefault();
  }}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  {#if commandResults.length}
    <div
      id="command-search-results"
      role="listbox"
      aria-label="Slash commands"
      class="absolute right-2 bottom-full left-2 z-30 mb-1.5 max-h-72 overflow-y-auto border border-border bg-popover p-1 shadow-2xl sm:right-auto sm:left-4 @2xl:left-52 sm:w-[32rem]"
    >
      {#each commandResults as result, index (`${result.entry.bot.userId}:${result.command.name}`)}
        <button
          id={`command-result-${index}`}
          type="button"
          role="option"
          aria-selected={selectedCommand === index}
          class={`flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left text-xs transition-colors ${selectedCommand === index ? 'bg-primary text-primary-foreground' : 'text-popover-foreground hover:bg-muted'}`}
          onmousedown={(event) => event.preventDefault()}
          onmouseenter={() => (selectedCommand = index)}
          onclick={() => pickCommand(result)}
        >
          <Avatar
            src={result.entry.bot.avatarUrl}
            name={result.entry.bot.displayName || result.entry.bot.username}
            class="size-5 shrink-0 text-[10px]"
            bgColor={result.entry.bot.avatarColor}
          />
          <span class="shrink-0 font-semibold">/{result.command.name}</span>
          <span class="min-w-0 truncate opacity-75">{result.command.description}</span>
          <span class="ml-auto shrink-0 opacity-60"
            >{result.entry.bot.displayName || result.entry.bot.username}</span
          >
        </button>
      {/each}
    </div>
  {/if}

  {#if emojiStart !== null && emojiResults.length}
    <div
      id="emoji-search-results"
      role="listbox"
      aria-label="Emoji search results"
      class="absolute right-2 bottom-full left-2 z-30 mb-1.5 max-h-56 overflow-y-auto border border-border bg-popover p-1 shadow-2xl sm:right-auto sm:left-4 @2xl:left-52 sm:w-[28rem]"
    >
      {#if emojiResults.length}
        <div class="grid grid-cols-1 sm:grid-cols-2">
          {#each emojiResults as emoji, index (emoji.unicode)}
            <button
              id={`emoji-result-${index}`}
              type="button"
              role="option"
              aria-selected={selectedEmoji === index}
              class={`flex min-w-0 items-center gap-2 px-1.5 py-1 text-left text-xs transition-colors ${selectedEmoji === index ? 'bg-primary text-primary-foreground' : 'text-popover-foreground hover:bg-muted'}`}
              onmousedown={(event) => event.preventDefault()}
              onmouseenter={() => (selectedEmoji = index)}
              onclick={() => insertEmoji(emoji)}
            >
              <img src={emoji.url} alt="" class="size-5 shrink-0 object-contain" />
              <span class="truncate">:{emoji.name.toLowerCase().replaceAll(' ', '_')}:</span>
            </button>
          {/each}
        </div>
      {:else if emojiQuery && realtime.emojiQuery.trim() === emojiQuery.trim()}
        <p class="px-2 py-3 text-center text-xs text-muted-foreground">No emoji found</p>
      {/if}
    </div>
  {/if}

  {#if mentionStart !== null}
    <div
      id="mention-search-results"
      role="listbox"
      aria-label="Member search results"
      class="absolute right-2 bottom-full left-2 z-30 mb-1.5 max-h-56 overflow-y-auto border border-border bg-popover p-1 shadow-2xl sm:right-auto sm:left-4 @2xl:left-52 sm:w-[28rem]"
    >
      {#if mentionResults.length}
        {#each mentionResults as result, index (result.id)}
          <button
            id={`mention-result-${index}`}
            type="button"
            role="option"
            aria-selected={selectedMention === index}
            class={`flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${selectedMention === index ? 'bg-primary text-primary-foreground' : 'text-popover-foreground hover:bg-muted'}`}
            onmousedown={(event) => event.preventDefault()}
            onmouseenter={() => (selectedMention = index)}
            onclick={() => insertMention(result.handle)}
          >
            <span class="truncate font-medium">{result.name}</span>
            <span class="ml-auto truncate opacity-70">@{result.handle}</span>
          </button>
        {/each}
      {:else}
        <p class="px-2 py-3 text-center text-xs text-muted-foreground">No members found</p>
      {/if}
    </div>
  {/if}

  <div
    class={cn(
      'relative overflow-hidden rounded-3xl border bg-card transition-colors focus-within:border-primary/60',
      draggingFiles ? 'border-primary' : 'border-transparent'
    )}
  >
    {#if context}
      <div class="border-b border-border/60">{@render context()}</div>
    {/if}

    {#if files.length > 0}
      <div class="flex gap-2 overflow-x-auto border-b border-border/60 p-2">
        {#each files as file, index (`${file.name}:${file.size}:${file.lastModified}`)}
          <div
            class="group relative size-20 shrink-0 overflow-hidden border border-border bg-background"
            title={file.name}
          >
            {#if previews[index]}
              <img src={previews[index]} alt={file.name} class="size-full object-cover" />
            {:else}
              <div class="flex size-full flex-col items-center justify-center gap-1.5 px-2 pb-4">
                <FileText class="size-5 text-primary" />
                <p class="w-full truncate text-center text-[11px] font-medium">{file.name}</p>
              </div>
            {/if}
            <span
              class="absolute bottom-1 left-1 bg-background/80 px-1 py-px text-[10px] text-muted-foreground tabular-nums backdrop-blur"
            >
              {formatBytes(file.size)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              class="absolute top-1 right-1 bg-background/80 backdrop-blur transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"
              disabled={sending}
              aria-label={`Remove ${file.name}`}
              onclick={() => (files = files.filter((item) => item !== file))}
            >
              <X class="size-3" />
            </Button>
          </div>
        {/each}
      </div>
    {/if}

    {#if sendError}
      <p
        class="border-b border-border/60 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        role="alert"
      >
        {sendError}
      </p>
    {/if}

    {#if activeCommand && chat.activeChannel}
      <CommandForm
        entry={activeCommand.entry}
        command={activeCommand.command}
        channelId={chat.activeChannel}
        onClose={closeCommand}
      />
    {/if}

    <div class="flex items-end gap-1 p-1.5" class:hidden={!!activeCommand}>
      <Button
        variant="ghost"
        size="icon-lg"
        class="size-10 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Add attachments"
        title="Add attachments"
        onclick={() => fileInput.click()}
      >
        <Paperclip class="size-4" />
      </Button>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        class="sr-only"
        aria-label="Choose files to attach"
        onchange={handleFileInput}
      />
      <textarea
        bind:value={content}
        bind:this={textarea}
        maxlength={maxMessageLength}
        onkeydown={handleKeydown}
        onkeyup={handleKeyup}
        oninput={updateSearch}
        onclick={updateSearch}
        {placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={emojiStart !== null || mentionStart !== null || commandResults.length > 0}
        aria-controls={commandResults.length
          ? 'command-search-results'
          : mentionStart !== null
            ? 'mention-search-results'
            : 'emoji-search-results'}
        aria-activedescendant={commandResults.length
          ? `command-result-${selectedCommand}`
          : mentionStart !== null && mentionResults.length
            ? `mention-result-${selectedMention}`
            : emojiStart !== null && emojiResults.length
              ? `emoji-result-${selectedEmoji}`
              : undefined}
        rows="1"
        class="field-sizing-content max-h-48 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2.5 text-[15px] leading-5 break-words text-foreground outline-none placeholder:text-muted-foreground"
      ></textarea>
      {#if remaining <= 200}
        <span
          class={cn(
            'flex h-10 shrink-0 items-center px-1 text-xs tabular-nums',
            remaining <= 0
              ? 'text-destructive'
              : remaining <= 50
                ? 'text-amber-500'
                : 'text-muted-foreground'
          )}
          aria-live="polite"
          title="Characters left"
        >
          {remaining}
        </span>
      {/if}
      <Button
        variant="ghost"
        size="icon-lg"
        onclick={handleSend}
        disabled={!canSend}
        aria-label="Send message"
        title={device.isComputer ? 'Send (Enter)' : 'Send'}
        class={cn(
          'size-10 shrink-0 transition-colors',
          canSend
            ? 'bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground dark:hover:bg-primary/85'
            : 'text-muted-foreground'
        )}
      >
        <SendHorizontal class="size-4" />
      </Button>
    </div>

    {#if draggingFiles}
      <div
        class="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 border border-dashed border-primary bg-card/90 text-sm font-medium text-primary"
      >
        <Paperclip class="size-4" />
        Drop to attach
      </div>
    {/if}
  </div>
</div>
