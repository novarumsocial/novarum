<script lang="ts">
  import type { Message } from '$lib/types/chat';
  import { Download, FileText } from '@lucide/svelte';

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
      <div class="mt-2 grid max-w-xl gap-2 sm:grid-cols-2">
        {#each message.attachments as attachment (attachment.id)}
          {#if attachment.contentType.startsWith('image/')}
            <a
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              class="group relative block overflow-hidden border border-border bg-muted/20"
            >
              <img
                src={attachment.url}
                alt={attachment.filename}
                loading="lazy"
                class="max-h-72 w-full object-cover"
              />
              <span
                class="absolute right-0 bottom-0 left-0 flex items-center justify-between gap-3 bg-background/90 px-2 py-1.5 text-[11px] backdrop-blur-sm"
              >
                <span class="truncate font-medium">{attachment.filename}</span>
                <Download class="size-3.5 shrink-0 text-muted-foreground" />
              </span>
            </a>
          {:else}
            <a
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              class="flex min-w-0 items-center gap-3 border border-border bg-muted/20 p-2.5 transition-colors hover:bg-muted/40"
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
            </a>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>
