<script lang="ts">
  import { cn } from '$lib/utils';
  import {
    ChevronDown,
    ChevronRight,
    Hash,
    MicOff,
    Plus,
    Settings,
    SquareArrowRightExit,
    UserRoundPlus,
    Volume2,
  } from '@lucide/svelte';
  import type { Author, Channel, ChannelCategory, Server } from '$lib/types/chat';
  import type { Voice } from '$lib/voice.svelte';
  import CreateChannelDialog from './create-channel-dialog.svelte';
  import InviteDialog from './invite-dialog.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

  let {
    server,
    categories,
    activeChannel,
    onSelectChannel,
    onCreateChannel,
    voice,
    members = [],
    voiceStates = {},
  }: {
    server: Server;
    categories: ChannelCategory[];
    activeChannel: string | null;
    onSelectChannel: (id: string) => void;
    onCreateChannel?: (channel: Channel) => Promise<Channel | void>;
    voice?: Voice | null;
    members?: Author[];
    voiceStates?: Record<string, { userId: string; name: string | null }[]>;
  } = $props();

  let collapsed = $state<Record<string, boolean>>({});
  let createOpen = $state(false);
  let createCategory = $state<ChannelCategory | null>(null);

  let createInviteOpen = $state(false);

  function openCreateChannel(category: ChannelCategory) {
    createCategory = category;
    createOpen = true;
  }

  function initialsFor(id: string) {
    return id
      .split(/[^a-zA-Z0-9]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
      .slice(0, 2);
  }

  function nameFor(identity: string) {
    const member = members.find((item) => item.userId === identity);

    return member?.displayName || member?.username || identity;
  }

  function voiceUsersFor(channelId: string) {
    return voiceStates[channelId] ?? [];
  }

  function avatarBg(id: string) {
    const colors = [
      'bg-rose-600',
      'bg-sky-600',
      'bg-emerald-600',
      'bg-amber-600',
      'bg-purple-600',
      'bg-cyan-600',
      'bg-pink-600',
      'bg-lime-600',
      'bg-indigo-600',
      'bg-teal-600',
      'bg-orange-600',
      'bg-violet-600',
    ];
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  function selectChannel(channel: Channel) {
    if (channel.type === 'VOICE') {
      if (voice?.channelId === channel.id && (voice.connected || voice.connecting)) {
        onSelectChannel(channel.id);
        return;
      }

      void voice?.join(channel.id).catch(() => null);
      return;
    }

    onSelectChannel(channel.id);
  }
</script>

<aside class="flex w-60 flex-col bg-sidebar">
  <!-- server header -->
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span class="truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
          {server.name}
        </span>
        <button
          class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Server settings"
        >
          <ChevronDown class="size-4" />
        </button>
      </div>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="w-52" align="center">
      <DropdownMenu.Group>
        <DropdownMenu.Item onclick={() => (createInviteOpen = true)}>
          Invite
          <DropdownMenu.Shortcut><UserRoundPlus class="size-3" /></DropdownMenu.Shortcut>
        </DropdownMenu.Item>
        <DropdownMenu.Item>
          Settings
          <DropdownMenu.Shortcut><Settings class="size-3" /></DropdownMenu.Shortcut>
        </DropdownMenu.Item>
      </DropdownMenu.Group>
      <DropdownMenu.Separator />
      <DropdownMenu.Item>
        Leave guild
        <DropdownMenu.Shortcut><SquareArrowRightExit class="size-3" /></DropdownMenu.Shortcut>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <!-- channel list -->
  <div class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
    {#each categories as cat}
      <button
        onclick={() => {
          collapsed[cat.id] = !collapsed[cat.id];
          collapsed = { ...collapsed };
        }}
        class="flex w-full items-center gap-1 px-1 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-sidebar-foreground"
      >
        {#if collapsed[cat.id]}
          <ChevronRight class="size-3 shrink-0" />
        {:else}
          <ChevronDown class="size-3 shrink-0" />
        {/if}
        {cat.label}
        <span
          onkeydown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            openCreateChannel(cat);
          }}
          onclick={(e) => {
            e.stopPropagation();
            openCreateChannel(cat);
          }}
          class="ml-auto cursor-pointer opacity-0 transition-opacity hover:opacity-100"
          role="button"
          tabindex="0"
          aria-label="Add channel"
        >
          <Plus class="size-3" />
        </span>
      </button>

      {#if !collapsed[cat.id]}
        {#each cat.channels as ch}
          <button
            onclick={() => selectChannel(ch)}
            class={cn(
              'flex w-full items-center gap-1.5 rounded-none px-2 py-1 text-left text-sm transition-colors',
              activeChannel === ch.id && 'bg-primary/10 text-sidebar-foreground',
              activeChannel !== ch.id && 'text-muted-foreground hover:text-sidebar-foreground'
            )}
          >
            {#if ch.type === 'VOICE'}
              <Volume2 class="size-4 shrink-0" />
            {:else}
              <Hash class="size-4 shrink-0" />
            {/if}
            <span class="flex-1 truncate">{ch.label || ch.name}</span>
            {#if ch.mention > 0}
              <span
                class="flex size-5 shrink-0 items-center justify-center bg-destructive text-[11px] font-bold text-destructive-foreground"
              >
                {ch.mention}
              </span>
            {/if}
            {#if ch.unread && ch.mention === 0}
              <span class="size-2 shrink-0 rounded-none bg-foreground/60"></span>
            {/if}
          </button>

          {@const connectedVoiceUsers = ch.type === 'VOICE' ? voiceUsersFor(ch.id) : []}
          {#if connectedVoiceUsers.length > 0}
            <div class="ml-6 mt-0.5 space-y-0.5 pb-0.5">
              {#each connectedVoiceUsers as state (state.userId)}
                {@const name = state.name || nameFor(state.userId)}
                <button
                  onclick={() => selectChannel(ch)}
                  class="flex w-full items-center gap-1.5 rounded-none px-2 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-sidebar-foreground"
                >
                  <div
                    class={cn(
                      'relative flex size-6 shrink-0 items-center justify-center text-[10px] font-bold text-white',
                      avatarBg(state.userId),
                      voice?.channelId === ch.id &&
                        voice.voiceStates.get(state.userId)?.speaking &&
                        'ring-2 ring-emerald-400'
                    )}
                  >
                    {voice?.channelId === ch.id && voice.voiceStates.get(state.userId)?.selfDeafened
                      ? '!'
                      : initialsFor(name)}
                  </div>
                  <span class="min-w-0 flex-1 truncate">
                    {name}
                  </span>
                  {#if voice?.channelId === ch.id && (voice.voiceStates.get(state.userId)?.selfMuted || voice.voiceStates.get(state.userId)?.selfDeafened)}
                    <MicOff class="size-3.5 shrink-0 text-rose-400" />
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        {/each}
      {/if}

      {#if cat.channels.length > 0}
        <div class="h-1"></div>
      {/if}
    {/each}
  </div>
</aside>

<CreateChannelDialog
  bind:open={createOpen}
  categoryLabel={createCategory?.label}
  onCreate={async (channel) => {
    if (!createCategory) return;
    const createdChannel = await onCreateChannel?.(channel);
    if (createdChannel) onSelectChannel(createdChannel.id);
  }}
/>

<InviteDialog bind:open={createInviteOpen} guildId={server.id} />
