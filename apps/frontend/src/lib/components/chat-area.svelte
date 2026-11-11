<script lang="ts">
  import {
    BellRing,
    Hash,
    CornerUpLeft,
    Megaphone,
    Menu,
    NotebookPen,
    Phone,
    RotateCw,
    Users,
    Volume2,
    X,
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { tick, type Snippet } from 'svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { dms } from '$lib/dms.svelte';
  import { settings } from '$lib/settings.svelte';
  import { cn } from '$lib/utils';
  import type { Channel, Message } from '$lib/types/chat';
  import MessageComponent from './message.svelte';
  import MessageInput from './message-input.svelte';
  import Avatar from './avatar.svelte';
  import { formatDate } from '$lib/formatDate';
  import { session } from '$lib/session.svelte';
  import { Progress } from '$lib/components/ui/progress/index.js';
  import CanvasPanel from './canvas-panel.svelte';

  // an optimistic message: shown right away, dropped once the server has accepted it, kept for a retry if it failed
  type Pending = {
    id: string;
    channelId: string;
    content: string | null;
    files: File[];
    replyTo: string | null;
    failed: boolean;
  };

  let {
    channel,
    messages,
    loading = false,
    onSend,
    onDelete,
    onEdit,
    onOpenNavigation,
    onToggleMembers,
    onCall,
    onRing,
    onProfileCall,
    call,
    callExpanded = false,
  }: {
    channel: Channel;
    messages: Message[];
    loading?: boolean;
    onSend?: (
      content: string | null,
      files: File[],
      replyTo: string | null
    ) => void | Promise<void>;
    onDelete: (messageId: string) => void | Promise<void>;
    onEdit: (messageId: string, content: string | null) => void | Promise<void>;
    onOpenNavigation?: () => void;
    onToggleMembers?: () => void;
    onCall?: () => void;
    onRing?: () => void;
    onProfileCall?: (channelId: string) => void;
    call?: Snippet;
    callExpanded?: boolean;
  } = $props();

  let callHeight = $state(320);
  let canvasOpen = $state(false);
  // canvases live on our own text and DM channels; federated ones would need their homeserver to host them
  const canvasSupported = $derived(channel.type !== 'VOICE' && !channel.id.startsWith('fed:'));
  const callers = $derived(channel.type === 'DM' ? (chat.voiceStates[channel.id] ?? []) : []);
  const ringing = $derived(!!call && dms.outgoingCall === channel.id);

  function resizeCall(event: PointerEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = callHeight;
    const move = (e: PointerEvent) => {
      callHeight = Math.min(
        Math.max(startHeight + e.clientY - startY, 160),
        window.innerHeight * 0.7
      );
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  let scrollContainer = $state<HTMLDivElement | null>(null);
  let scrollContent = $state<HTMLDivElement | null>(null);
  let olderLoading = $state(false);
  let previousChannelId: string | null = null;
  let unreadBoundary = $state<{ channelId: string; lastReadMessageId: string | null } | null>(null);
  let replyingTo = $state<Message | null>(null);
  const messagesById = $derived(new Map(messages.map((message) => [message.id, message])));
  const firstUnreadIndex = $derived.by(() => {
    const boundary = unreadBoundary;
    if (boundary?.channelId !== channel.id) return -1;
    if (!boundary.lastReadMessageId) return 0;

    const lastReadIndex = messages.findIndex(
      (message) => message.id === boundary.lastReadMessageId
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
    if (channel.id === previousChannelId) return;
    previousChannelId = channel.id;
    unreadBoundary = channel.unread
      ? { channelId: channel.id, lastReadMessageId: channel.lastReadMessageId }
      : null;
    replyingTo = null;
    olderLoading = false;
  });

  /*
   * Scrolling has one rule set, so late layout (thumbnails, embeds, older pages) can't fight it:
   * - while `stuck`, the view follows the bottom, however the content or the viewport resize
   * - otherwise the message at the top of the view keeps its place on screen
   * Scrolling up unsticks, reaching the bottom sticks again. The browser's own scroll anchoring
   * is off (overflow-anchor: none) so it can't move things a second time.
   */
  let stuck = true;
  let lastScrollTop = 0;
  let anchor: { element: Element; offset: number } | null = null;

  function scrollToBottom() {
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    lastScrollTop = scrollContainer.scrollTop;
  }

  // the first message whose bottom is inside the view, and how far it sits from the top
  function captureAnchor() {
    const container = scrollContainer;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    const element = [...container.querySelectorAll('[data-message-id]')].find(
      (item) => item.getBoundingClientRect().bottom > top
    );
    anchor = element ? { element, offset: element.getBoundingClientRect().top - top } : null;
  }

  function keepPosition() {
    const container = scrollContainer;
    if (!container || loading) return;
    if (stuck) return scrollToBottom();
    if (!anchor?.element.isConnected) return captureAnchor();
    const top = container.getBoundingClientRect().top;
    container.scrollTop += anchor.element.getBoundingClientRect().top - top - anchor.offset;
    lastScrollTop = container.scrollTop;
  }

  $effect(() => {
    if (!scrollContainer || !scrollContent) return;
    const observer = new ResizeObserver(keepPosition);
    observer.observe(scrollContainer);
    observer.observe(scrollContent);
    return () => observer.disconnect();
  });

  // opening a channel lands at the bottom; a linked message (search, reply, notification) is centred
  let settledChannel: string | null = null;
  $effect(() => {
    const channelId = channel.id;
    const messageId = chat.activeMessage;
    if (loading || !scrollContainer) return;
    const channelChanged = channelId !== settledChannel;
    // the message id leaving the url (after jumping to a reply) must not move the view
    if (!channelChanged && !messageId) return;
    settledChannel = channelId;

    void tick().then(() => {
      const target = messageId ? document.getElementById(messageId) : null;
      if (target) {
        stuck = false;
        target.scrollIntoView({ block: 'center' });
        lastScrollTop = scrollContainer?.scrollTop ?? 0;
        captureAnchor();
      } else {
        stuck = true;
        scrollToBottom();
      }
    });
  });

  let pending = $state<Pending[]>([]);
  const channelPending = $derived(pending.filter((item) => item.channelId === channel.id));
  const uploadProgress = $derived.by(() => {
    const values = Object.values(chat.uploadProgress);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  });

  // sends in the background: the composer clears right away and the message waits in the list as "sending"
  async function send(item: Pending) {
    pending = pending.map((p) => (p.id === item.id ? { ...p, failed: false } : p));
    try {
      await onSend?.(item.content, item.files, item.replyTo);
      pending = pending.filter((p) => p.id !== item.id);
    } catch {
      pending = pending.map((p) => (p.id === item.id ? { ...p, failed: true } : p));
    }
  }

  function sendMessage(content: string | null, files: File[]) {
    const item: Pending = {
      id: crypto.randomUUID(),
      channelId: channel.id,
      content,
      files,
      replyTo: replyingTo?.id ?? null,
      failed: false,
    };
    pending = [...pending, item];
    unreadBoundary = null;
    replyingTo = null;
    void send(item);
    // sending always brings you back down to your message
    stuck = true;
    void tick().then(scrollToBottom);
  }

  function onScroll() {
    const container = scrollContainer;
    if (!container) return;
    const top = container.scrollTop;
    const fromBottom = container.scrollHeight - container.clientHeight - top;
    // only a real move up unsticks, so content growing under a stuck view never does
    if (fromBottom < 48) stuck = true;
    else if (top < lastScrollTop - 1) stuck = false;
    lastScrollTop = top;
    captureAnchor();

    if (loading || olderLoading || top > 100 || !chat.hasMoreMessages(channel.id)) return;
    void loadOlder();
  }

  // older messages are prepended; keepPosition holds the view on the same message meanwhile
  async function loadOlder() {
    if (!scrollContainer || loading || olderLoading) return;
    captureAnchor();
    olderLoading = true;
    await chat.loadOlderMessages(channel.id);
    olderLoading = false;
  }
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && (unreadBoundary = null)} />

{#snippet skeletonRows(count: number)}
  {#each Array.from({ length: count }) as _, i}
    <div class="flex gap-3" class:opacity-60={i > 2}>
      <div class="mt-0.5 size-6 shrink-0 animate-pulse bg-muted"></div>
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
{/snippet}

{#snippet pendingMessage(item: Pending)}
  {@const name = session.user?.displayName || session.user?.username || 'You'}
  <!-- same compact row as message.svelte -->
  <div class="mt-2 flex gap-2.5 py-0.5">
    <Avatar
      src={session.user?.avatarUrl}
      {name}
      class="mt-px size-6 text-[10px]"
      bgColor={session.user?.avatarColor}
    />
    <div class="min-w-0 flex-1">
      <span class="float-left mr-2 flex h-[1.40625rem] items-center text-[15px] font-semibold">
        <span class="user-ink" style:--user-color={session.user?.avatarColor}>{name}</span>
      </span>
      <div class:opacity-60={!item.failed}>
        {#if item.content}
          <div class="whitespace-pre-wrap break-words text-[15px] leading-normal text-foreground">
            {item.content}
          </div>
        {/if}
        {#if item.files.length > 0}
          <p class="text-xs text-muted-foreground">
            {item.files.length} attachment{item.files.length === 1 ? '' : 's'}
          </p>
          {#if !item.failed && uploadProgress !== null}
            <Progress value={uploadProgress} max={1} class="mt-1 h-0.5 max-w-xs" />
          {/if}
        {/if}
      </div>
      {#if item.failed}
        <div class="flex items-center gap-1 text-xs text-destructive">
          <button
            type="button"
            class="flex items-center gap-1.5 hover:underline"
            onclick={() => send(item)}
          >
            <RotateCw class="size-3.5" />
            Failed to send. Click to retry
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Discard message"
            onclick={() => (pending = pending.filter((p) => p.id !== item.id))}
          >
            <X class="size-3.5 text-muted-foreground" />
          </Button>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

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
    {:else if channel.type === 'DM'}
      <Avatar
        src={channel.avatarUrl}
        name={channel.name}
        class="size-6 text-[10px]"
        bgColor={channel.avatarColor}
      />
    {:else}
      <Hash class="size-5 text-muted-foreground" />
    {/if}
    <span class="text-[15px] font-semibold text-foreground">{channel.name}</span>
    {#if channel.topic}
      <span class="mx-1.5 text-muted-foreground/30">|</span>
      <span class="truncate text-xs text-muted-foreground/70">{channel.topic}</span>
    {/if}
    <div class="flex-1"></div>
    {#if canvasSupported}
      <Button
        variant={canvasOpen ? 'secondary' : 'ghost'}
        size="icon-lg"
        onclick={() => (canvasOpen = !canvasOpen)}
        aria-label={canvasOpen ? 'Close canvas' : 'Open canvas'}
        aria-pressed={canvasOpen}
        title="Canvas"
      >
        <NotebookPen class="size-5" />
      </Button>
    {/if}
    {#if channel.type === 'DM'}
      {#if !call}
        <Button variant="ghost" size="icon-lg" onclick={onCall} aria-label="Start call">
          <Phone class="size-5" />
        </Button>
      {:else if callers.length <= 1 && !ringing}
        <Button variant="ghost" size="icon-lg" onclick={onRing} aria-label="Ring" title="Ring">
          <BellRing class="size-5" />
        </Button>
      {/if}
    {:else}
      <Button
        variant="ghost"
        size="icon-lg"
        onclick={onToggleMembers}
        aria-label="Toggle member list"
      >
        <Users class="size-5" />
      </Button>
    {/if}
  </div>

  {#if !call && callers.length}
    <div class="flex shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-4 py-2">
      <Phone class="size-4 shrink-0 animate-pulse text-green-500" />
      <span class="flex-1 truncate text-sm text-foreground">
        {callers.map((state) => state.name ?? 'Someone').join(', ')}
        {callers.length === 1 ? 'is' : 'are'} in the call
      </span>
      <Button size="sm" class="bg-green-600 text-white hover:bg-green-700" onclick={onCall}>
        Join
      </Button>
    </div>
  {/if}

  {#if call}
    <div
      class="relative flex border-b border-border"
      class:flex-1={callExpanded}
      class:shrink-0={!callExpanded}
      style:height={callExpanded ? null : `${callHeight}px`}
    >
      {@render call()}
      {#if ringing}
        <div class="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
          <div
            class={cn(
              'flex min-w-0 items-center gap-2 border border-border bg-sidebar/80 py-1.5 pr-3 pl-1.5 text-sm text-foreground shadow-lg backdrop-blur',
              settings.value.circleIcons && 'rounded-pill'
            )}
          >
            <Avatar
              src={channel.avatarUrl}
              name={channel.name}
              class="size-6 animate-pulse text-[10px]"
              bgColor={channel.avatarColor}
            />
            <span class="truncate">Ringing {channel.name}…</span>
          </div>
        </div>
      {/if}
      {#if !callExpanded}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize call"
          class="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-row-resize touch-none transition-colors hover:bg-primary/40 pointer-coarse:-bottom-2.5 pointer-coarse:h-5"
          onpointerdown={resizeCall}
        ></div>
      {/if}
    </div>
  {/if}

  <div class={call && callExpanded ? 'hidden' : 'relative flex min-h-0 flex-1'}>
    <div class="@container flex min-w-0 flex-1 flex-col">
      <div
        bind:this={scrollContainer}
        class="min-h-0 min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        onscroll={onScroll}
      >
        <div bind:this={scrollContent} class="flex min-h-full flex-col">
          {#if olderLoading}
            <div class="space-y-5 px-3 pt-4 sm:px-4">
              {@render skeletonRows(2)}
            </div>
          {/if}
          <div class="flex flex-1 flex-col justify-end px-3 py-4 sm:px-4">
            {#if loading}
              <div class="space-y-5">
                {@render skeletonRows(5)}
              </div>
            {:else if messages.length === 0 && channelPending.length === 0}
              <div class="mb-4 flex max-w-md flex-col items-start gap-3 select-none">
                {#if channel.type === 'DM'}
                  <Avatar
                    src={channel.avatarUrl}
                    name={channel.name}
                    class="size-14 text-lg"
                    bgColor={channel.avatarColor}
                  />
                {/if}
                <div class="border border-dashed border-border p-4">
                  <p class="text-sm font-medium text-foreground">
                    {channel.type === 'DM'
                      ? `This is the beginning of your conversation with ${channel.name}.`
                      : 'No messages yet'}
                  </p>
                  {#if channel.type !== 'DM'}
                    <p class="mt-1 text-sm text-muted-foreground">
                      Start the conversation in #{channel.name}.
                    </p>
                  {/if}
                </div>
              </div>
            {:else}
              <div>
                {#each messages as msg, i (msg.id)}
                  {@const prev = messages[i - 1]}
                  {@const firstUnread = i === firstUnreadIndex}
                  {@const repliedMessage = (msg.replyTo && messagesById.get(msg.replyTo)) || null}
                  {@const grouped =
                    !firstUnread &&
                    prev !== undefined &&
                    !msg.interaction &&
                    !msg.ephemeral &&
                    prev.author.username === msg.author.username &&
                    prev.author.server === msg.author.server &&
                    msg.timestamp.getTime() - prev.timestamp.getTime() < 5 * 60 * 1000}
                  {@const dayDivider =
                    (i > 0 &&
                      msg.timestamp.toDateString() !== messages[i - 1].timestamp.toDateString()) ||
                    i === 0}
                  {#if dayDivider}
                    <div
                      class="mt-5 mb-2 flex justify-center"
                      role="separator"
                      aria-label={msg.timestamp.toLocaleDateString()}
                    >
                      <span
                        class="rounded-pill bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground"
                      >
                        {formatDate(msg.timestamp)}
                      </span>
                    </div>
                  {/if}
                  {#if firstUnread}
                    <div
                      id={`unread-${channel.id}`}
                      class="mt-4 flex items-center gap-3 text-xs font-semibold text-tertiary"
                      role="separator"
                      aria-label="New messages"
                    >
                      <span class="h-px flex-1 bg-tertiary/50"></span>
                      <span
                        class="rounded-pill bg-tertiary-container px-2.5 py-0.5 text-foreground"
                      >
                        New
                      </span>
                      <span class="h-px flex-1 bg-tertiary/50"></span>
                    </div>
                  {/if}
                  <MessageComponent
                    message={msg}
                    {repliedMessage}
                    {grouped}
                    {onDelete}
                    {onEdit}
                    onReply={() => (replyingTo = msg)}
                    {onProfileCall}
                  />
                {/each}
                {#each channelPending as item (item.id)}
                  {@render pendingMessage(item)}
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>

      {#if typingText}
        <div
          class="flex h-6 shrink-0 items-center px-3 text-xs text-muted-foreground sm:px-4"
          aria-live="polite"
        >
          <span class="flex items-center gap-0.5 mr-2.5">
            <span
              class="size-1 animate-bounce rounded-pill bg-muted-foreground [animation-delay:-0.3s]"
            ></span>
            <span
              class="size-1 animate-bounce rounded-pill bg-muted-foreground [animation-delay:-0.15s]"
            ></span>
            <span class="size-1 animate-bounce rounded-pill bg-muted-foreground"></span>
          </span>
          {typingText ?? ''}
        </div>
      {/if}

      {#if chat.canSendInCurrentChannel}
        <MessageInput
          placeholder={channel.type === 'DM'
            ? `Message @${channel.name}`
            : `Message #${channel.name}`}
          onSend={sendMessage}
          onTyping={() => chat.onTyping()}
          context={replyingTo ? replyContext : undefined}
        />
        {#snippet replyContext()}
          <div class="flex items-center gap-2 py-1.5 pr-1.5 pl-3 text-xs">
            <CornerUpLeft class="size-3.5 shrink-0 text-primary" />
            <div class="min-w-0 flex-1 border-l-2 border-primary/50 pl-2">
              <p class="truncate text-muted-foreground">
                Replying to <span class="font-medium text-foreground"
                  >{replyingTo?.author.displayName || replyingTo?.author.username}</span
                >
              </p>
              <p class="truncate text-muted-foreground">
                {replyingTo?.content ||
                  `${replyingTo?.attachments.length} attachment${replyingTo?.attachments.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Cancel reply"
              title="Cancel reply"
              onclick={() => (replyingTo = null)}
            >
              <X class="size-3.5" />
            </Button>
          </div>
        {/snippet}
      {:else}
        <div
          class="flex min-h-12 shrink-0 items-center justify-center gap-2 border-t border-border px-3 text-sm text-muted-foreground"
        >
          <Megaphone class="size-4" />
          Only the server owner can send messages in this channel.
        </div>
      {/if}
    </div>
    {#if canvasOpen && canvasSupported}
      {#key channel.id}
        <CanvasPanel channelId={channel.id} onClose={() => (canvasOpen = false)} />
      {/key}
    {/if}
  </div>
</div>
