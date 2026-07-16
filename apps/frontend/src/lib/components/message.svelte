<script lang="ts">
  import type { Message } from '$lib/types/chat';
  import { chat } from '$lib/chat-state.svelte';
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
  import EmojiText from './emoji-text.svelte';
  import * as ButtonGroup from '$lib/components/ui/button-group/index.js';
  import type { LucideProps } from '@lucide/svelte';
  import type { Component } from 'svelte';

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

  const dropdownItems = [
    {
      label: () => 'Message link',
      icon: Link,
      variant: 'default',
      onclick: () => {
        const url = chat.messagePath(message.id);
        navigator.clipboard.writeText(`${window.location.origin}${url}`);
      },
    },
    {
      label: () => deleteText,
      icon: Trash2,
      variant: 'destructive',
      onclick: deleteMessage,
      disabled: () => deleting,
      closeOnSelect: false,
    },
  ] as DropdownItems[];

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
  class="relative flex gap-3 py-0.5 first:mt-0 hover:bg-muted/30 motion-reduce:animate-none"
  class:animate-message-flash={chat.activeMessage === message.id}
  class:mt-0.5={grouped}
  class:mt-4={!grouped}
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
  role="group"
>
  {#if !grouped}
    <Avatar src={message.author.avatarUrl} name={authorName} class="mt-0.5 size-9 text-xs" />
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
