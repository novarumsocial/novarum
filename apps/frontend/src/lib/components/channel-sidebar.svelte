<script lang="ts">
  import { cn } from '$lib/utils';
  import {
    ChevronDown,
    ChevronRight,
    Hash,
    LogOut,
    MicOff,
    Plus,
    Settings,
    UserRoundPlus,
    Volume2,
    Bell,
    IdCardLanyard
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';
  import type { Author, Channel, ChannelCategory, Server } from '$lib/types/chat';
  import type { Voice } from '$lib/voice.svelte';
  import { settings } from '$lib/settings.svelte';
  import CreateChannelDialog from './create-channel-dialog.svelte';
  import InviteDialog from './invite-dialog.svelte';
  import GuildSettingsDialog from './guild-settings-dialog.svelte';
  import Avatar from './avatar.svelte';
  import ParticipantContextMenu from './participant-context-menu.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

  let {
    server,
    categories,
    activeChannel,
    onSelectChannel,
    onCreateChannel,
    onReorderChannels,
    onSaveChannelOrder,
    canReorder = false,
    voice,
    members = [],
    voiceStates = {},
  }: {
    server: Server;
    categories: ChannelCategory[];
    activeChannel: string | null;
    onSelectChannel: (id: string) => void;
    onCreateChannel?: (channel: Channel) => Promise<Channel | void>;
    onReorderChannels: (channelIds: string[]) => void;
    onSaveChannelOrder: (channelIds: string[]) => Promise<void>;
    canReorder?: boolean;
    voice?: Voice | null;
    members?: Author[];
    voiceStates?: Record<string, { userId: string; name: string | null }[]>;
  } = $props();

  let collapsed = $state<Record<string, boolean>>({});
  let createOpen = $state(false);
  let createCategory = $state<ChannelCategory | null>(null);

  let createInviteOpen = $state(false);
  let settingsOpen = $state(false);

  const flipDurationMs = 150;

  let orderedChannels = $state<Record<string, Channel[]>>({});
  let reorderLoading = $state(false);

  $effect(() => {
    const current = untrack(() => orderedChannels);

    orderedChannels = Object.fromEntries(
      categories.map((category) => {
        const incomingById = new Map(category.channels.map((channel) => [channel.id, channel]));

        const existing = (current[category.id] ?? [])
          .map((channel) => incomingById.get(channel.id))
          .filter((channel): channel is Channel => channel !== undefined);

        const existingIds = new Set(existing.map((channel) => channel.id));
        const added = category.channels.filter((channel) => !existingIds.has(channel.id));

        return [category.id, [...existing, ...added]];
      })
    );
  });

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

  function avatarFor(identity: string) {
    return members.find((item) => item.userId === identity)?.avatarUrl;
  }

  function avatarColorFor(identity: string) {
    return members.find((item) => item.userId === identity)?.avatarColor;
  }

  function voiceUsersFor(channelId: string) {
    const users = [...(voiceStates[channelId] ?? [])];

    if (voice?.channelId === channelId) {
      for (const [userId] of voice.voiceStates) {
        if (!users.some((user) => user.userId === userId)) {
          users.push({
            userId,
            name: nameFor(userId),
          });
        }
      }
    }

    return users;
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
    onSelectChannel(channel.id);
  }

  function channelIdsWithOrder(categoryId: string, reordered: Channel[]) {
    return categories.flatMap((category) =>
      (category.id === categoryId
        ? reordered
        : (orderedChannels[category.id] ?? category.channels)
      ).map((channel) => channel.id)
    );
  }

  function handleConsider(categoryId: string, event: CustomEvent<DndEvent<Channel>>) {
    orderedChannels = {
      ...orderedChannels,
      [categoryId]: event.detail.items,
    };
  }

  async function handleFinalize(categoryId: string, event: CustomEvent<DndEvent<Channel>>) {
    orderedChannels = {
      ...orderedChannels,
      [categoryId]: event.detail.items,
    };

    const channelIds = channelIdsWithOrder(categoryId, event.detail.items);

    onReorderChannels(channelIds);

    reorderLoading = true;
    document.documentElement.classList.add('cursor-spinner');

    try {
      await onSaveChannelOrder(channelIds);
    } finally {
      document.documentElement.classList.remove('cursor-spinner');
      reorderLoading = false;
    }
  }
</script>

<aside class="flex w-60 flex-col bg-sidebar">
  <!-- Server header -->
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
        {#if server.canManageChannels}
          <DropdownMenu.Item onclick={() => (createInviteOpen = true)}>
            Invite

            <DropdownMenu.Shortcut>
              <UserRoundPlus class="size-3" />
            </DropdownMenu.Shortcut>
          </DropdownMenu.Item>
        {/if}

        {#if server.canManageChannels}
          <DropdownMenu.Item onclick={() => (settingsOpen = true)}>
            Settings

            <DropdownMenu.Shortcut>
              <Settings class="size-3" />
            </DropdownMenu.Shortcut>
          </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Group>

      <DropdownMenu.Separator />
      <DropdownMenu.Item>
        Notification Settings
        <DropdownMenu.Shortcut>
          <Bell class="size-3"/>
        </DropdownMenu.Shortcut>
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item variant="destructive">
        Leave Guild
        <DropdownMenu.Shortcut>
          <LogOut class="size-3" style="color: var(--destructive);"/>
        </DropdownMenu.Shortcut>
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item>
        Copy Guild ID
        <DropdownMenu.Shortcut>
          <IdCardLanyard class="size-3"/>
        </DropdownMenu.Shortcut>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <!-- Channel list -->
  <div class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
    {#each categories as cat (cat.id)}
      <div class="flex w-full items-center gap-1 px-1 py-1">
        <button
          onclick={() => openCreateChannel(cat)}
          aria-label="Add channel"
          class="peer order-2 cursor-pointer text-muted-foreground opacity-70 transition-opacity hover:text-sidebar-foreground hover:opacity-100"
        >
          {#if server.canManageChannels}
            <Plus class="size-3 shrink-0" />
          {/if}
        </button>

        <button
          onclick={() => {
            collapsed[cat.id] = !collapsed[cat.id];
            collapsed = { ...collapsed };
          }}
          class="order-1 flex flex-1 items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-sidebar-foreground peer-hover:text-sidebar-foreground"
        >
          {#if collapsed[cat.id]}
            <ChevronRight class="size-3 shrink-0" />
          {:else}
            <ChevronDown class="size-3 shrink-0" />
          {/if}

          {cat.label}
        </button>
      </div>

      {#if !collapsed[cat.id]}
        {@const channels = orderedChannels[cat.id] ?? cat.channels}

        <div
          use:dndzone={{
            items: channels,
            type: `channels:${server.id}:${cat.id}`,
            flipDurationMs,
            dragDisabled: !canReorder,
            dropTargetStyle: {
              outline: 'none',
            },
          }}
          onconsider={(event) => handleConsider(cat.id, event)}
          onfinalize={(event) => handleFinalize(cat.id, event)}
          aria-label={`${cat.label} channel order`}
        >
          {#each channels as ch (ch.id)}
            {@const connectedVoiceUsers = ch.type === 'VOICE' ? voiceUsersFor(ch.id) : []}

            <div animate:flip={{ duration: flipDurationMs }} class="touch-none">
              <button
                onclick={() => selectChannel(ch)}
                class={cn(
                  'flex w-full items-center gap-1.5 rounded-none px-2 py-1 text-left text-sm transition-colors',
                  activeChannel === ch.id && 'bg-primary/10 text-sidebar-foreground',
                  activeChannel !== ch.id && 'text-muted-foreground hover:text-sidebar-foreground',
                  reorderLoading && 'opacity-70'
                )}
              >
                {#if ch.type === 'VOICE'}
                  <Volume2 class="size-4 shrink-0" />
                {:else}
                  <Hash
                    class={cn('size-4 shrink-0', (ch.unread || ch.mention > 0) && 'text-white')}
                  />
                {/if}

                <span class="flex-1 truncate" class:text-white={ch.unread || ch.mention > 0}>
                  {ch.label || ch.name}
                </span>

                {#if ch.mention > 0}
                  <span class="flex size-5 shrink-0 items-center justify-center">
                    <span
                      class="flex size-5 items-center justify-center bg-destructive text-[11px] font-bold text-destructive-foreground"
                      class:rounded-full={settings.value.circleIcons}
                    >
                      {ch.mention > 99 ? '99+' : ch.mention}
                    </span>
                  </span>
                {/if}

                {#if ch.unread && ch.mention === 0}
                  <span class="flex size-5 shrink-0 items-center justify-center">
                    <span
                      class="size-2 bg-foreground/80"
                      class:rounded-full={settings.value.circleIcons}
                    ></span>
                  </span>
                {/if}
              </button>

              {#if connectedVoiceUsers.length > 0}
                <div class="ml-6 mt-0.5 space-y-0.5 pb-0.5">
                  {#each connectedVoiceUsers as state (state.userId)}
                    {@const name = state.name || nameFor(state.userId)}
                    {@const voiceState = voice?.voiceStates.get(state.userId)}

                    <ParticipantContextMenu {voice} identity={state.userId} {name}>
                      <button
                        onclick={() => selectChannel(ch)}
                        class="flex w-full items-center gap-1.5 rounded-none px-2 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-sidebar-foreground"
                      >
                        <Avatar
                          src={avatarFor(state.userId)}
                          {name}
                          fallback={initialsFor(name)}
                          bgColor={avatarColorFor(state.userId)}
                          class={cn(
                            'relative flex size-6 shrink-0 items-center justify-center text-[10px] font-bold text-white',
                            avatarBg(state.userId),
                            voice?.channelId === ch.id &&
                              voiceState?.speaking &&
                              'ring-2 ring-emerald-400'
                          )}
                        />

                        <span class="min-w-0 flex-1 truncate">
                          {name}
                        </span>

                        {#if voice?.channelId === ch.id && (voiceState?.selfMuted || voiceState?.selfDeafened)}
                          <MicOff class="size-3.5 shrink-0 text-rose-400" />
                        {/if}
                      </button>
                    </ParticipantContextMenu>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
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

    if (createdChannel) {
      onSelectChannel(createdChannel.id);
    }
  }}
/>

<InviteDialog bind:open={createInviteOpen} guildId={server.id} />

<GuildSettingsDialog bind:open={settingsOpen} {server} />
