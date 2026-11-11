<script lang="ts">
  import { cn } from '$lib/utils';
  import {
    ChevronDown,
    ChevronRight,
    Ellipsis,
    Hash,
    LogOut,
    MicOff,
    Video,
    Plus,
    Settings,
    UserRoundPlus,
    Volume2,
    Bell,
    IdCardLanyard,
    HeadphoneOff,
    Eye,
    Pin,
    Pencil,
    Trash2,
    CopyPlus,
    Link,
    Megaphone,
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';
  import type { Author, Channel, ChannelCategory, Server } from '$lib/types/chat';
  import type { Voice } from '$lib/voice.svelte';
  import { settings } from '$lib/settings.svelte';
  import CreateChannelDialog from './create-channel-dialog.svelte';
  import EditChannelDialog from './edit-channel-dialog.svelte';
  import InviteDialog from './invite-dialog.svelte';
  import GuildSettingsDialog from './guild-settings-dialog.svelte';
  import Avatar from './avatar.svelte';
  import ServerRow from './server-row.svelte';
  import ParticipantContextMenu from './participant-context-menu.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import ProfileCard from './profile-card.svelte';
  import NotificationMenu from './notification-menu.svelte';
  import { notificationSettings } from '$lib/notification-settings.svelte';
  import { tabs } from '$lib/tabs.svelte';

  let {
    server,
    categories,
    activeChannel,
    onSelectChannel,
    onCreateChannel,
    onReorderChannels,
    onSaveChannelOrder,
    onSetOwnerOnly,
    folded = false,
    onToggleFold,
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
    onSetOwnerOnly?: (channelId: string, ownerOnly: boolean) => void;
    folded?: boolean;
    onToggleFold?: () => void;
    canReorder?: boolean;
    voice?: Voice | null;
    members?: Author[];
    voiceStates?: Record<string, { userId: string; name: string | null }[]>;
  } = $props();

  let collapsed = $state<Record<string, boolean>>({});

  // A folded server keeps showing what needs you: unread channels, mentions, and where you are.
  const isShown = (channel: Channel) => {
    if (!folded || channel.id === activeChannel || channel.id === voice?.channelId) return true;
    const target = { channelId: channel.id, guildId: server.id };
    return (
      (channel.unread && notificationSettings.showsUnread(target)) ||
      (channel.mention > 0 && notificationSettings.showsMentions(target))
    );
  };
  const anyShown = $derived(categories.some((category) => category.channels.some(isShown)));
  let createOpen = $state(false);
  let createCategory = $state<ChannelCategory | null>(null);
  let editOpen = $state(false);
  let editChannel = $state<Channel | null>(null);
  let deleteChannelText = $state<Record<string, string>>({});
  let armedChannelId = $state<string | null>(null);
  let deletingChannel = $state(false);
  let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  let shiftPressed = $state(false);

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

  $effect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftPressed = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftPressed = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
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

  function userFor(identity: string) {
    return members.find((item) => item.userId === identity);
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

  function openEditChannel(channel: Channel) {
    editChannel = channel;
    editOpen = true;
  }

  async function deleteChannel(channel: Channel) {
    if (deletingChannel) return;

    if (!shiftPressed && armedChannelId !== channel.id) {
      deleteChannelText[channel.id] = 'You sure?';
      armedChannelId = channel.id;
      if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = setTimeout(() => {
        deleteChannelText[channel.id] = 'Delete Channel';
        armedChannelId = null;
      }, 3000);
      return;
    }

    if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
    deletingChannel = true;
    deleteChannelText[channel.id] = 'Deleting...';
    // TODO: implement deleteChannel
    deletingChannel = false;
    deleteChannelText[channel.id] = 'Delete Channel';
    armedChannelId = null;
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

<section>
  <ContextMenu.Root>
    <ContextMenu.Trigger class="contents">
      <ServerRow
        {server}
        expanded={!folded}
        unread={folded && anyShown}
        onToggle={() => onToggleFold?.()}
      >
        {#snippet actions()}
          {#if server.canManageChannels && categories.length === 1}
            <button
              type="button"
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground opacity-0 group-hover/server:opacity-100 rounded-pill hover:bg-muted hover:text-foreground focus-visible:opacity-100"
              aria-label="Add a channel to {server.name}"
              title="Add channel"
              onclick={() => openCreateChannel(categories[0])}
            >
              <Plus class="size-3.5" />
            </button>
          {/if}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground opacity-0 group-hover/server:opacity-100 rounded-pill hover:bg-muted hover:text-foreground focus-visible:opacity-100 aria-expanded:opacity-100"
              aria-label="{server.name} options"
            >
              <Ellipsis class="size-4" />
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
                  <Bell class="size-3" />
                </DropdownMenu.Shortcut>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item variant="destructive">
                Leave Guild
                <DropdownMenu.Shortcut>
                  <LogOut class="size-3" style="color: var(--destructive);" />
                </DropdownMenu.Shortcut>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item>
                Copy Guild ID
                <DropdownMenu.Shortcut>
                  <IdCardLanyard class="size-3" />
                </DropdownMenu.Shortcut>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/snippet}
      </ServerRow>
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-56">
      <NotificationMenu targetId={server.id} noun="Server" />
    </ContextMenu.Content>
  </ContextMenu.Root>

  <!-- Channel list, hung off a guide line under the server's chevron -->
  {#if anyShown}
    <div class="mr-2 mb-2 ml-7 space-y-0.5">
      {#each categories as cat (cat.id)}
        <!-- a lone category's heading says nothing; its add button moves up to the server row -->
        {#if categories.length > 1 && !folded}
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
              class="order-1 flex flex-1 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-sidebar-foreground peer-hover:text-sidebar-foreground"
            >
              {#if collapsed[cat.id]}
                <ChevronRight class="size-3 shrink-0" />
              {:else}
                <ChevronDown class="size-3 shrink-0" />
              {/if}

              {cat.label}
            </button>
          </div>
        {/if}

        {#if folded || !collapsed[cat.id]}
          {@const channels = (orderedChannels[cat.id] ?? cat.channels).filter(isShown)}

          <div
            use:dndzone={{
              items: channels,
              type: `channels:${server.id}:${cat.id}`,
              flipDurationMs,
              dragDisabled: !canReorder || folded,
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
              {@const target = { channelId: ch.id, guildId: server.id }}
              {@const showMention = ch.mention > 0 && notificationSettings.showsMentions(target)}
              {@const showUnread = ch.unread && notificationSettings.showsUnread(target)}

              <div animate:flip={{ duration: flipDurationMs }} class="touch-none">
                <ContextMenu.Root>
                  <ContextMenu.Trigger>
                    <button
                      onclick={() => selectChannel(ch)}
                      ondblclick={() => ch.type === 'TEXT' && tabs.keep(ch.id)}
                      class={cn(
                        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-pill px-3 text-left text-sm transition-colors',
                        activeChannel === ch.id &&
                          'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                        activeChannel !== ch.id &&
                          'text-muted-foreground hover:bg-accent hover:text-sidebar-foreground',
                        (showUnread || showMention) && 'font-semibold text-sidebar-foreground',
                        reorderLoading && 'opacity-70'
                      )}
                    >
                      {#if ch.type === 'VOICE'}
                        <Volume2 class="size-4 shrink-0" />
                      {:else}
                        <Hash class="size-4 shrink-0" />
                      {/if}

                      <span class="flex-1 truncate">
                        {ch.label || ch.name}
                      </span>

                      {#if showMention}
                        <span class="flex size-5 shrink-0 items-center justify-center">
                          <span
                            class="flex h-4.5 min-w-4.5 items-center justify-center rounded-pill bg-destructive px-1 text-[10px] font-bold text-destructive-foreground"
                            class:rounded-full={settings.value.circleIcons}
                          >
                            {ch.mention > 99 ? '99+' : ch.mention}
                          </span>
                        </span>
                      {/if}

                      {#if showUnread && !showMention}
                        <span class="flex size-5 shrink-0 items-center justify-center">
                          <span
                            class="size-2 rounded-pill bg-tertiary"
                            class:rounded-full={settings.value.circleIcons}
                          ></span>
                        </span>
                      {/if}
                    </button>
                  </ContextMenu.Trigger>

                  <ContextMenu.Content class="w-56">
                    {#if ch.type === 'TEXT'}
                      <ContextMenu.Item disabled={!ch.unread && ch.mention === 0}>
                        <Eye class="size-4" />
                        Mark as Read
                      </ContextMenu.Item>
                    {/if}
                    <ContextMenu.Item>
                      <UserRoundPlus class="size-4" />
                      Invite to Channel
                    </ContextMenu.Item>
                    <ContextMenu.Item>
                      <Pin class="size-4" />
                      Pin Channel to Top
                    </ContextMenu.Item>
                    <ContextMenu.Item onclick={() => navigator.clipboard.writeText(ch.id)}>
                      <Link class="size-4" />
                      Copy Link
                    </ContextMenu.Item>

                    <ContextMenu.Separator />

                    <NotificationMenu targetId={ch.id} guildId={server.id} noun="Channel" />

                    <ContextMenu.Separator />

                    <ContextMenu.Item onclick={() => openEditChannel(ch)}>
                      <Pencil class="size-4" />
                      Edit Channel
                    </ContextMenu.Item>

                    {#if server.canManageChannels}
                      {#if ch.type === 'TEXT'}
                        <ContextMenu.CheckboxItem
                          checked={ch.ownerOnly ?? false}
                          onCheckedChange={(checked) => onSetOwnerOnly?.(ch.id, checked)}
                        >
                          <Megaphone class="size-4" />
                          Only Owner Can Send
                        </ContextMenu.CheckboxItem>
                      {/if}
                      <ContextMenu.Item>
                        <CopyPlus class="size-4" />
                        Duplicate Channel
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        variant="destructive"
                        closeOnSelect={false}
                        onclick={() => deleteChannel(ch)}
                        disabled={deletingChannel}
                      >
                        <Trash2 class="size-4" />
                        {deleteChannelText[ch.id] ?? 'Delete Channel'}
                      </ContextMenu.Item>
                    {/if}

                    <ContextMenu.Separator />

                    <ContextMenu.Item onclick={() => navigator.clipboard.writeText(ch.id)}>
                      <IdCardLanyard class="size-3" />
                      Copy Channel ID
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Root>

                {#if connectedVoiceUsers.length > 0}
                  <div class="ml-6 mt-0.5 space-y-0.5 pb-0.5">
                    {#each connectedVoiceUsers as state (state.userId)}
                      {@const name = state.name || nameFor(state.userId)}
                      {@const live =
                        voice?.channelId === ch.id
                          ? voice.voiceStates.get(state.userId)
                          : undefined}
                      {@const user = userFor(state.userId)!}

                      <ProfileCard {user} class="group flex w-full cursor-auto">
                        <ParticipantContextMenu {voice} identity={state.userId} {name}>
                          <div
                            class="flex w-full items-center gap-1.5 rounded-none px-2 py-0.5 text-left text-sm text-muted-foreground transition-colors"
                          >
                            <div class="relative shrink-0">
                              <Avatar
                                src={avatarFor(state.userId)}
                                {name}
                                fallback={initialsFor(name)}
                                bgColor={avatarColorFor(state.userId)}
                                class="flex size-6 items-center justify-center text-[10px] font-bold text-white {avatarBg(
                                  state.userId
                                )}"
                              />
                              {#if live?.speaking}
                                <div
                                  class="pointer-events-none absolute inset-0"
                                  style:box-shadow="inset 0 0 0 1.5px {userFor(state.userId)
                                    ?.speakingRingColor ?? '#00d492'}, inset 0 0 0 2.5px
                                  var(--color-sidebar)"
                                  class:rounded-full={settings.value.circleIcons}
                                ></div>
                              {/if}
                            </div>

                            <span
                              class="min-w-0 flex-1 truncate group-hover:text-sidebar-foreground"
                            >
                              {name}
                            </span>

                            {#if live?.selfDeafened}
                              <MicOff class="size-3.5 shrink-0 text-rose-400" aria-label="Muted" />
                              <HeadphoneOff
                                class="size-3.5 shrink-0 text-rose-400"
                                aria-label="Deafened"
                              />
                            {:else if live?.selfMuted}
                              <MicOff class="size-3.5 shrink-0 text-rose-400" aria-label="Muted" />
                            {/if}
                            {#if live?.camera}
                              <Video class="size-3.5 shrink-0" aria-label="Camera on" />
                            {/if}
                            {#if live?.screenShare}
                              <span
                                class="shrink-0 bg-rose-600 px-1 py-px text-[10px] leading-none font-bold text-white"
                                class:rounded-full={settings.value.circleIcons}
                                title="Sharing their screen"
                              >
                                LIVE
                              </span>
                            {/if}
                          </div>
                        </ParticipantContextMenu>
                      </ProfileCard>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if cat.channels.length > 0 && !folded}
          <div class="h-1"></div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

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

<EditChannelDialog
  bind:open={editOpen}
  channel={editChannel}
  onSave={(channel, name) => {
    // TODO: implement editChannel
  }}
/>
