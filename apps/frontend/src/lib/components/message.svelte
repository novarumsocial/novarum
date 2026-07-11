<script lang="ts">
  import type { Message } from '$lib/types/chat';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Download, FileAudio, FileText, FileVideo } from '@lucide/svelte';
  import AttachmentViewer from './attachment-viewer.svelte';

  let {
    message,
    grouped,
  }: {
    message: Message;
    grouped: boolean;
  } = $props();

  function formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const authorName = $derived(message.author.displayName || message.author.username);
  const viewableAttachments = $derived(
    message.attachments.filter(
      (attachment) =>
        attachment.contentType.startsWith('image/') ||
        attachment.contentType.startsWith('video/') ||
        attachment.contentType.startsWith('audio/') ||
        attachment.contentType === 'application/pdf',
    ),
  );
  let viewerOpen = $state(false);
  let viewerIndex = $state(0);

  function viewAttachment(id: string) {
    viewerIndex = viewableAttachments.findIndex((attachment) => attachment.id === id);
    viewerOpen = true;
  }
</script>

<div class="flex gap-3" class:mt-1={grouped} class:mt-4={!grouped}>
  {#if !grouped}
    <div
      class="mt-0.5 flex size-9 shrink-0 items-center justify-center text-xs font-bold text-white {message
        .author.avatarColor}"
    >
      {authorName.charAt(0).toUpperCase()}
    </div>
  {:else}
    <div class="w-9 shrink-0"></div>
  {/if}

  <div class="min-w-0 flex-1">
    {#if !grouped}
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-semibold text-foreground">
          {authorName}
        </span>
        <span class="text-[11px] text-muted-foreground">{formatTime(message.timestamp)}</span>
        <span class="text-[10px] text-muted-foreground/50">{message.author.server}</span>
      </div>
    {/if}

    <div class="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
      {message.content}
    </div>

    {#if message.attachments.length > 0}
      <div class="mt-2 grid max-w-md grid-cols-2 gap-1.5 sm:grid-cols-3">
        {#each message.attachments as attachment (attachment.id)}
          {#if attachment.contentType.startsWith('image/')}
            <Button
              variant="outline"
              class="group relative aspect-[4/3] h-auto min-w-0 overflow-hidden p-0 text-left"
              aria-label={`View ${attachment.filename}`}
              onclick={() => viewAttachment(attachment.id)}
            >
              <img
                src={attachment.url}
                alt={attachment.filename}
                loading="lazy"
                class="size-full object-cover transition-transform group-hover:scale-[1.02]"
              />
            </Button>
          {:else if attachment.contentType.startsWith('video/') || attachment.contentType.startsWith('audio/') || attachment.contentType === 'application/pdf'}
            <Button
              variant="outline"
              class="h-auto min-w-0 justify-start gap-2 p-2 text-left"
              onclick={() => viewAttachment(attachment.id)}
            >
              <div class="flex size-8 shrink-0 items-center justify-center bg-muted">
                {#if attachment.contentType.startsWith('video/')}
                  <FileVideo class="size-4 text-primary" />
                {:else if attachment.contentType.startsWith('audio/')}
                  <FileAudio class="size-4 text-primary" />
                {:else}
                  <FileText class="size-4 text-primary" />
                {/if}
              </div>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[11px] font-medium">{attachment.filename}</span>
                <span class="font-mono text-[9px] uppercase text-muted-foreground">View</span>
              </span>
            </Button>
          {:else}
            <Button
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              variant="outline"
              class="h-auto min-w-0 justify-start gap-2 p-2 text-left"
            >
              <div class="flex size-9 shrink-0 items-center justify-center bg-muted">
                <FileText class="size-4 text-primary" />
              </div>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium">{attachment.filename}</span>
                <span class="font-mono text-[10px] uppercase text-muted-foreground">
                  {formatBytes(attachment.size)}
                </span>
              </span>
              <Download class="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

<AttachmentViewer bind:open={viewerOpen} bind:index={viewerIndex} attachments={viewableAttachments} />
