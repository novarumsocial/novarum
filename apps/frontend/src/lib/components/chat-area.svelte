<script lang="ts">
  import { Hash, Menu, Users, Volume2, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { tick } from 'svelte';
  import { chat } from '$lib/chat-state.svelte';
  import type { Channel, Message } from '$lib/types/chat';
  import MessageComponent from './message.svelte';
  import MessageInput from './message-input.svelte';

  let {
    channel,
    messages,
    loading = false,
    onSend,
    onDelete,
    onOpenNavigation,
    onOpenMembers,
  }: {
    channel: Channel;
    messages: Message[];
    loading?: boolean;
    onSend?: (content: string, files: File[], replyTo: string | null) => void | Promise<void>;
    onDelete: (messageId: string) => void | Promise<void>;
    onOpenNavigation?: () => void;
    onOpenMembers?: () => void;
  } = $props();

  let scrollContainer = $state<HTMLDivElement | null>(null);
  let previousChannelId: string | null = null;
  let unreadBoundary = $state<{ channelId: string; lastReadMessageId: string | null } | null>(
    null
  );
  let replyingTo = $state<Message | null>(null);
  const messagesById = $derived(new Map(messages.map((message) => [message.id, message])));
  const firstUnreadIndex = $derived.by(() => {
    if (unreadBoundary?.channelId !== channel.id) return -1;
    if (!unreadBoundary.lastReadMessageId) return 0;

    const lastReadIndex = messages.findIndex(
      (message) => message.id === unreadBoundary.lastReadMessageId
    );
    if (lastReadIndex < 0) return 0;

    return lastReadIndex < messages.length - 1 ? lastReadIndex + 1 : -1;
  });

  const typingText = $derived.by(() => {
    const typing = chat.currentTyping;
    if (typing.length === 0) return null;
    if (typing.length === 1) return `${typing[0].name} is typing...`;
    if (typing.length === 2) return `${typing[0].name} and ${typing[1].name} are typing...`;

    return 'Several people are typing...';
  });

  $effect(() => {
    const channelChanged = channel.id !== previousChannelId;
    const messageId = chat.activeMessage;
    messages.length;

    if (channelChanged) {
      previousChannelId = channel.id;
      unreadBoundary = channel.unread
        ? { channelId: channel.id, lastReadMessageId: channel.lastReadMessageId }
        : null;
      replyingTo = null;
    }

    if (!scrollContainer || loading) return;

    void tick().then(() => {
      if (messageId) {
        document.getElementById(messageId)?.scrollIntoView({ block: 'center' });
        return;
      }

      if (channelChanged && firstUnreadIndex >= 0) {
        document.getElementById(`unread-${channel.id}`)?.scrollIntoView({ block: 'center' });
        return;
      }

      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  });

  async function sendMessage(content: string, files: File[]) {
    await onSend?.(content, files, replyingTo?.id ?? null);
    replyingTo = null;
  }
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
  <div class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-4">
    <Button
      variant="ghost"
      size="icon-lg"
      class="md:hidden"
      onclick={onOpenNavigation}
      aria-label="Open channels"
    >
      <Menu class="size-5" />
    </Button>
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
    <Button
      variant="ghost"
      size="icon-lg"
      class="ml-auto lg:hidden"
      onclick={onOpenMembers}
      aria-label="Open members"
    >
      <Users class="size-5" />
    </Button>
  </div>

  <div bind:this={scrollContainer} class="min-h-0 min-w-0 flex-1 overflow-y-auto">
    <div class="flex min-h-full flex-col justify-end px-3 py-4 sm:px-4">
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
        <div>
          {#each messages as msg, i}
            {@const prev = messages[i - 1]}
            {@const firstUnread = i === firstUnreadIndex}
            {@const repliedMessage = (msg.replyTo && messagesById.get(msg.replyTo)) || null}
            {@const grouped =
              !firstUnread &&
              prev !== undefined &&
              prev.author.username === msg.author.username &&
              prev.author.server === msg.author.server &&
              msg.timestamp.getTime() - prev.timestamp.getTime() < 5 * 60 * 1000}
            {#if firstUnread}
              <div
                id={`unread-${channel.id}`}
                class="my-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-destructive"
                role="separator"
                aria-label="New messages"
              >
                <span class="h-px flex-1 bg-destructive"></span>
                <span>New</span>
              </div>
            {/if}
            <MessageComponent
              message={msg}
              {repliedMessage}
              {grouped}
              {onDelete}
              onReply={() => (replyingTo = msg)}
            />
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div
    class="flex h-6 shrink-0 items-center px-3 text-xs text-muted-foreground sm:px-4"
    aria-live="polite"
  >
    {typingText ?? ''}
  </div>

  {#if replyingTo}
    <div class="flex h-8 shrink-0 items-center gap-2 border-t border-border px-3 text-xs sm:px-4">
      <span class="min-w-0 flex-1 truncate text-muted-foreground">
        Replying to <span class="font-medium text-foreground"
          >{replyingTo.author.displayName || replyingTo.author.username}</span
        >
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Cancel reply"
        onclick={() => (replyingTo = null)}
      >
        <X class="size-3.5" />
      </Button>
    </div>
  {/if}

  <MessageInput
    placeholder="Message #{channel.name}"
    onSend={sendMessage}
    onTyping={() => chat.onTyping()}
  />
</div>
