<script lang="ts">
  import type { Message } from '$lib/types/chat';

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

    <div class="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
      {message.content}
    </div>
  </div>
</div>
