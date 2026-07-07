<script lang="ts">
  import { Hash, Globe, Volume2 } from '@lucide/svelte';
  import { chat } from '$lib/chat-state.svelte';
  import type { Channel, Message } from '$lib/types/chat';
  import MessageComponent from './message.svelte';
  import MessageInput from './message-input.svelte';

  let {
    channel,
    messages,
    loading = false,
    onSend,
  }: {
    channel: Channel;
    messages: Message[];
    loading?: boolean;
    onSend?: (content: string) => void;
  } = $props();

  let scrollContainer = $state<HTMLDivElement | null>(null);

  const typingText = $derived.by(() => {
    const typing = chat.currentTyping;
    if (typing.length === 0) return null;
    if (typing.length === 1) return `${typing[0].name} is typing...`;
    if (typing.length === 2) return `${typing[0].name} and ${typing[1].name} are typing...`;

    return 'Several people are typing...';
  });

  $effect(() => {
    channel.id;
    loading;
    messages.length;

    if (!scrollContainer || loading) return;

    requestAnimationFrame(() => {
      scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight });
    });
  });
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

  <div bind:this={scrollContainer} class="flex-1 overflow-y-auto">
    <div class="flex min-h-full flex-col justify-end px-4 py-4">
      {#if loading}
        <div class="space-y-5">
          {#each Array.from({ length: 5 }) as _, i}
            <div class="flex gap-3" class:opacity-60={i > 2}>
              <div class="mt-0.5 size-9 shrink-0 animate-pulse bg-muted"></div>
              <div class="min-w-0 flex-1 space-y-2">
                <div class="flex items-center gap-2">
                  <div class="h-3 w-24 animate-pulse bg-muted"></div>
                  <div class="h-2 w-10 animate-pulse bg-muted/70"></div>
                </div>
                <div class="h-3 w-3/4 animate-pulse bg-muted"></div>
                <div class="h-3 w-1/2 animate-pulse bg-muted/70"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if messages.length === 0}
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

  <div class="flex h-6 shrink-0 items-center px-4 text-xs text-muted-foreground" aria-live="polite">
    {typingText ?? ''}
  </div>

  <MessageInput placeholder="Message #{channel.name}" {onSend} onTyping={() => chat.onTyping()} />
</div>
