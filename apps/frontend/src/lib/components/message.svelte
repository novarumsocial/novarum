<script lang="ts">
  import type { Message } from '$lib/types/chat';
  import { chat } from '$lib/chat-state.svelte';
  import { session } from '$lib/session.svelte';
  import { Button, type ButtonVariant } from '$lib/components/ui/button/index.js';
  import {
    Download,
    FileAudio,
    FileText,
    FileVideo,
    Reply,
    Ellipsis,
    Trash2,
    Link,
  } from '@lucide/svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import AttachmentViewer from './attachment-viewer.svelte';
  import Avatar from './avatar.svelte';
  import ProfileCard from './profile-card.svelte';
  import EmojiText from './emoji-text.svelte';
  import * as ButtonGroup from '$lib/components/ui/button-group/index.js';
  import type { LucideProps } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { settings } from '$lib/settings.svelte';

  let {
    message,
    repliedMessage,
    grouped,
    onDelete,
    onReply,
  }: {
    message: Message;
    repliedMessage: Message | null;
    grouped: boolean;
    onDelete: (messageId: string) => void | Promise<void>;
    onReply: () => void;
  } = $props();

  let shiftPressed = $state(false);

  let hovered = $state(false);
  let dropdownOpen = $state(false);
  let deleting = $state(false);
  let deleteText = $state('Delete');
  let deleteFirstClick = $state(false);

  const dropdownItems: DropdownItems[] = $derived([
    {
      label: () => 'Message link',
      icon: Link,
      variant: 'default',
      onclick: () => {
        const url = chat.messagePath(message.id);
        navigator.clipboard.writeText(`${window.location.origin}${url}`);
      },
    },
    ...(message.author.userId === session.user?.id
      ? [
          {
            label: () => deleteText,
            icon: Trash2,
            variant: 'destructive' as const,
            onclick: deleteMessage,
            disabled: () => deleting,
            closeOnSelect: false,
          },
        ]
      : []),
  ]);

  $effect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftPressed = true;
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftPressed = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  });

  function formatTime(date: Date): string {
    if (settings.value.timeFormat === 'auto') {
      const locale = navigator.language || 'en-US';
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    }
    if (settings.value.timeFormat === '12hr') {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    }
    if (settings.value.timeFormat === '24hr') {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }

    // this should never show up unless you have manipulated the settings in the console or something
    return 'what did you do lmao';
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const authorName = $derived(message.author.displayName || message.author.username);
  const selfMentioned = $derived.by(() => {
    const handle = session.user?.handle.toLowerCase();
    if (!handle || message.author.userId === session.user?.id) return false;

    const contentHandles =
      message.content.match(
        /(?<![a-zA-Z0-9._])@[a-zA-Z0-9._]+:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?/g
      ) ?? [];

    return [...message.pingedHandles, ...contentHandles].some(
      (pingedHandle) => pingedHandle.toLowerCase() === handle
    );
  });
  const viewableAttachments = $derived(
    message.attachments.filter(
      (attachment) =>
        attachment.contentType.startsWith('image/') ||
        attachment.contentType.startsWith('video/') ||
        attachment.contentType.startsWith('audio/') ||
        attachment.contentType === 'application/pdf'
    )
  );
  let viewerOpen = $state(false);
  let viewerIndex = $state(0);

  function viewAttachment(id: string) {
    viewerIndex = viewableAttachments.findIndex((attachment) => attachment.id === id);
    viewerOpen = true;
  }

  async function deleteMessage() {
    if (deleting) return;

    if (!shiftPressed && !deleteFirstClick) {
      deleteText = 'You sure?';
      deleteFirstClick = true;
      await new Promise((resolve) =>
        setTimeout(() => {
          deleteText = 'Delete';
          deleteFirstClick = false;
          // what the fuck is javascript
          resolve(void 0);
        }, 3000)
      );
      return;
    }

    deleting = true;
    deleteText = 'Deleting...';
    try {
      await onDelete(message.id);
      dropdownOpen = false;
    } finally {
      deleting = false;
    }
  }

  // i should probably put this elsewhere lmao im losong my sanity
  interface DropdownItems {
    label: () => string;
    icon: Component<LucideProps, {}, ''>;
    onclick: () => void | Promise<void>;
    variant?: 'default' | 'destructive';
    disabled?: () => boolean;
    closeOnSelect?: boolean;
  }
</script>

<div
  id={message.id}
  class="relative -mx-3 flex gap-3 px-3 py-0.5 first:mt-0 motion-reduce:animate-none sm:-mx-4 sm:px-4 {selfMentioned
    ? 'bg-amber-400/10 hover:bg-amber-400/15'
    : 'hover:bg-muted/30'}"
  class:animate-message-flash={chat.activeMessage === message.id}
  onanimationend={() => {
    if (chat.activeMessage === message.id) {
      goto(chat.existingChannelPath(), { replaceState: true, noScroll: true, keepFocus: true });
    }
  }}
  class:mt-0.5={grouped}
  class:mt-4={!grouped}
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
  role="group"
>
  {#if selfMentioned}
    <span class="absolute inset-y-0 left-0 w-0.5 bg-amber-400" aria-hidden="true"></span>
  {/if}
  {#if !grouped}
    <ProfileCard user={message.author} class="self-start">
      <Avatar
        src={message.author.avatarUrl}
        name={authorName}
        class="mt-0.5 size-9 text-xs"
        bgColor={message.author.avatarColor}
      />
    </ProfileCard>
  {:else}
    <div class="w-9 shrink-0"></div>
  {/if}

  <div class="min-w-0 flex-1">
    {#if !grouped}
      <div class="flex items-baseline gap-2">
        <ProfileCard user={message.author} class="text-sm font-semibold text-foreground">
          {authorName}
        </ProfileCard>
        <span class="text-[11px] text-muted-foreground">{formatTime(message.timestamp)}</span>
      </div>
    {/if}

    {#if message.replyTo}
      <a
        href={chat.messagePath(message.replyTo)}
        class="mt-0.5 flex max-w-2xl min-w-0 items-start gap-1 border-l-2 border-primary/40 pl-1.5 text-[11px] leading-4 hover:border-primary hover:bg-muted/40"
      >
        <Reply class="size-3 shrink-0 text-primary/60" aria-hidden="true" />
        {#if repliedMessage}
          <span class="shrink-0 font-medium text-foreground/75">
            {repliedMessage.author.displayName || repliedMessage.author.username}
          </span>
          <span class="text-muted-foreground/40">·</span>
          <span class="min-w-0 break-words text-muted-foreground">
            {#if repliedMessage.content}
              <EmojiText content={repliedMessage.content} />
            {:else}
              {repliedMessage.attachments.length} attachment{repliedMessage.attachments.length === 1
                ? ''
                : 's'}
            {/if}
          </span>
        {:else}
          <span class="italic text-muted-foreground/70">Original message unavailable</span>
        {/if}
      </a>
    {/if}

    <div class="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
      <EmojiText content={message.content} links />
    </div>

    {#if hovered || dropdownOpen}
      <div class="absolute top-0 right-0">
        <ButtonGroup.Root>
          <Button variant="ghost" size="icon-xs" aria-label="Reply" onclick={onReply}
            ><Reply class="size-3" /></Button
          >
          {#if shiftPressed}
            {#each dropdownItems as item (item.label)}
              <Button
                onclick={item.onclick}
                variant={item.variant}
                disabled={item.disabled?.()}
                size="icon-xs"
              >
                <item.icon class="size-3" />
              </Button>
            {/each}
          {:else}
            <DropdownMenu.Root bind:open={dropdownOpen}>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button {...props} variant="ghost" size="icon-xs" aria-label="Message actions">
                    <Ellipsis class="size-3" />
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.Group>
                  {#each dropdownItems as item (item.label)}
                    <DropdownMenu.Item
                      onclick={item.onclick}
                      disabled={item.disabled?.()}
                      variant={item.variant}
                      closeOnSelect={item.closeOnSelect ?? true}
                    >
                      <item.icon class="size-3" />
                      {item.label()}
                    </DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {/if}
        </ButtonGroup.Root>
      </div>
    {/if}

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

<AttachmentViewer
  bind:open={viewerOpen}
  bind:index={viewerIndex}
  attachments={viewableAttachments}
/>
