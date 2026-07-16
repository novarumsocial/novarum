<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { realtime } from '$lib/realtime.svelte';
  import { FileText, Paperclip, Send, X } from '@lucide/svelte';

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
  const emojiResults = $derived(
    realtime.emojiQuery.trim() === emojiQuery.trim() ? realtime.emojiResults : []
  );
  const maxFiles = 5;
  const maxFileSize = 10 * 1024 * 1024;
  let {
    placeholder = 'Send a message',
    onSend = () => {},
    onTyping = () => {},
  }: {
    placeholder?: string;
    onSend?: (content: string, files: File[]) => void | Promise<void>;
    onTyping?: () => void;
  } = $props();

  async function handleSend() {
    const trimmed = content.trim();
    if (!trimmed || sending) return;

    sending = true;
    sendError = '';
    try {
      await onSend(trimmed, files);
      content = '';
      files = [];
      closeEmojiSearch();
    } catch (error) {
      sendError = error instanceof Error ? error.message : 'Could not send message';
    } finally {
      sending = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
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

    if (e.key === 'Escape' && emojiStart !== null) {
      e.preventDefault();
      closeEmojiSearch();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (content.trim() || e.key.length === 1) onTyping();
  }

  function updateEmojiSearch() {
    const cursor = textarea.selectionStart;
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
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateEmojiSearch();
  }

  function closeEmojiSearch() {
    emojiStart = null;
    emojiQuery = '';
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
      sendError = `${oversized.name} exceeds the 10 MB limit.`;
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
    if (textarea !== document.activeElement) {
      textarea.focus();
    }
  }
</script>

<svelte:window onkeydown={windowKeyDown} />

<div
  class="relative border-t border-border p-2 sm:p-4"
  role="group"
  aria-label="Message composer"
  ondragenter={handleDragEnter}
  ondragover={(event) => {
    if (hasDraggedFiles(event)) event.preventDefault();
  }}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  {#if emojiStart !== null && emojiResults.length}
    <div
      id="emoji-search-results"
      role="listbox"
      aria-label="Emoji search results"
      class="absolute right-2 bottom-full left-2 z-30 mb-1.5 max-h-56 overflow-y-auto border border-border bg-popover p-1 shadow-2xl sm:right-auto sm:left-4 sm:w-[28rem]"
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

  {#if files.length > 0}
    <div class="mb-2 flex gap-2 overflow-x-auto pb-1">
      {#each files as file (`${file.name}:${file.size}:${file.lastModified}`)}
        <div
          class="flex max-w-56 shrink-0 items-center gap-2 border border-border bg-muted/30 py-1.5 pr-1 pl-2"
        >
          <FileText class="size-3.5 shrink-0 text-primary" />
          <div class="min-w-0">
            <p class="truncate text-[11px] font-medium text-foreground">{file.name}</p>
            <p class="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
              {(file.size / 1024).toFixed(file.size < 1024 * 10 ? 1 : 0)} KB
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
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
      class="mb-2 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      {sendError}
    </p>
  {/if}

  <div
    class={`flex items-end gap-2 border bg-background p-2 transition-colors focus-within:border-primary/50 ${draggingFiles ? 'border-primary bg-primary/5' : 'border-border'}`}
  >
    <Button
      variant="ghost"
      size="icon-lg"
      class="self-center text-muted-foreground hover:text-foreground"
      aria-label="Add attachments"
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
      onkeydown={handleKeydown}
      onkeyup={handleKeyup}
      oninput={updateEmojiSearch}
      onclick={updateEmojiSearch}
      {placeholder}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={emojiStart !== null}
      aria-controls="emoji-search-results"
      aria-activedescendant={emojiStart !== null && emojiResults.length
        ? `emoji-result-${selectedEmoji}`
        : undefined}
      rows="1"
      class="min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto break-words bg-transparent px-1 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
    ></textarea>
    <Button
      onclick={handleSend}
      size="icon-lg"
      disabled={!content.trim() || sending}
      aria-label="Send message"
    >
      <Send class="size-4" />
    </Button>
  </div>
</div>
