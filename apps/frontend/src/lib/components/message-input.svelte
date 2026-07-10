<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { FileText, Paperclip, Send, X } from '@lucide/svelte';
  import FileUploadDialog from './file-upload-dialog.svelte';

  let content = $state('');
  let files = $state<File[]>([]);
  let uploadDialogOpen = $state(false);
  let sending = $state(false);
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
    try {
      await onSend(trimmed, files);
      content = '';
      files = [];
    } finally {
      sending = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (content.trim() || e.key.length === 1) onTyping();
  }
</script>

<div class="border-t border-border p-4">
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

  <div
    class="flex items-end gap-2 border border-border bg-background p-2 focus-within:border-primary/50"
  >
    <Button
      variant="ghost"
      size="icon-lg"
      class="text-muted-foreground hover:text-foreground"
      aria-label="Add attachments"
      onclick={() => (uploadDialogOpen = true)}
    >
      <Paperclip class="size-4" />
    </Button>
    <textarea
      bind:value={content}
      onkeydown={handleKeydown}
      {placeholder}
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

<FileUploadDialog bind:open={uploadDialogOpen} bind:files />
