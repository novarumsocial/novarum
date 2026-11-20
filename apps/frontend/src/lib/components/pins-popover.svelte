<script lang="ts">
  import { Pin, PinOff } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat-state.svelte';
  import { formatDate, formatTime } from '$lib/formatDate';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import Avatar from './avatar.svelte';
  import Markdown from './markdown.svelte';

  let { channelId }: { channelId: string } = $props();

  let open = $state(false);
  let error = $state<string | null>(null);
  const pins = $derived(chat.pinsByChannel[channelId]);

  $effect(() => {
    if (!open) return;
    error = null;
    chat.loadPins(channelId).catch((e: Error) => (error = e.message));
  });

  function jump(messageId: string) {
    open = false;
    void goto(chat.messagePath(messageId));
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant={open ? 'secondary' : 'ghost'}
        size="icon-lg"
        aria-label="Pinned messages"
        title="Pinned messages"
      >
        <Pin class="size-5" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content align="end" class="w-96 max-w-[calc(100vw-1rem)] gap-0 p-0">
    <Popover.Header class="border-b border-border px-3 py-2">
      <Popover.Title class="text-sm font-semibold">Pinned messages</Popover.Title>
    </Popover.Header>
    <div class="max-h-[60vh] overflow-y-auto">
      {#if error}
        <p class="p-4 text-center text-muted-foreground">{error}</p>
      {:else if !pins}
        <p class="p-4 text-center text-muted-foreground">Loading…</p>
      {:else if !pins.length}
        <p class="p-4 text-center text-muted-foreground">No pinned messages yet.</p>
      {:else}
        {#each pins as pin (pin.id)}
          <div class="group flex gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
            <Avatar
              src={pin.author.avatarUrl}
              name={pin.author.displayName || pin.author.username}
              class="size-7 shrink-0 text-[10px]"
              bgColor={pin.author.avatarColor}
            />
            <button class="min-w-0 flex-1 text-left" onclick={() => jump(pin.id)}>
              <span class="flex items-baseline gap-2">
                <span class="truncate text-xs font-semibold text-foreground">
                  {pin.author.displayName || pin.author.username}
                </span>
                <span class="shrink-0 text-[10px] text-muted-foreground">
                  {formatDate(pin.timestamp)} at {formatTime(pin.timestamp)}
                </span>
              </span>
              <span class="line-clamp-3 text-xs text-foreground/90">
                {#if pin.content}
                  <Markdown content={pin.content} inline />
                {:else}
                  <span class="text-muted-foreground italic">
                    {pin.attachments.length} attachment{pin.attachments.length === 1 ? '' : 's'}
                  </span>
                {/if}
              </span>
            </button>
            {#if chat.canPinInCurrentChannel}
              <Button
                variant="ghost"
                size="icon-xs"
                class="shrink-0 opacity-60 group-hover:opacity-100"
                aria-label="Unpin message"
                title="Unpin message"
                onclick={() =>
                  chat.setPinned(channelId, pin.id, false).catch((e: Error) => (error = e.message))}
              >
                <PinOff class="size-3.5" />
              </Button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </Popover.Content>
</Popover.Root>
