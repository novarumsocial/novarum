<script lang="ts">
  import { Hash, Globe, Volume2 } from '@lucide/svelte';
  import type { Channel, Message } from '$lib/types/chat';
  import MessageComponent from './message.svelte';
  import MessageInput from './message-input.svelte';

  let {
    channel,
    messages,
    onSend = () => {},
  }: {
    channel: Channel;
    messages: Message[];
    onSend?: (content: string) => void;
  } = $props();
</script>

<div class="flex flex-1 flex-col bg-background">
  <div class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
    {#if channel.type === 'VOICE'}
      <Volume2 class="size-5 text-muted-foreground" />
    {:else}
      <Hash class="size-5 text-muted-foreground" />
    {/if}
    <span class="text-sm font-semibold text-foreground">{channel.name}</span>
    {#if channel.topic}
      <span class="mx-1.5 text-muted-foreground/30">|</span>
      <span class="truncate text-xs text-muted-foreground/70">{channel.topic}</span>
    {/if}
  </div>

  <div class="flex-1 overflow-y-auto">
    <div class="flex min-h-full flex-col justify-end px-4 py-4">
      {#if messages.length === 0}
        <div class="mb-4 max-w-md border border-dashed border-border p-4">
          <p class="text-sm font-medium text-foreground">No messages yet</p>
          <p class="mt-1 text-sm text-muted-foreground">
            Start the conversation in #{channel.name}.
          </p>
        </div>
      {:else}
        <div class="space-y-4">
          {#each messages as msg, i}
            {@const prev = messages[i - 1]}
            {@const grouped =
              prev !== undefined &&
              prev.author.username === msg.author.username &&
              prev.author.server === msg.author.server &&
              msg.timestamp.getTime() - prev.timestamp.getTime() < 5 * 60 * 1000}
            <MessageComponent message={msg} {grouped} />
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <MessageInput placeholder="Message #{channel.name}" {onSend} />
</div>
