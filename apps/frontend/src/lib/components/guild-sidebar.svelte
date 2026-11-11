<script lang="ts">
  import { Pin, Plus } from '@lucide/svelte';
  import { flip } from 'svelte/animate';
  import { untrack } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';

  import type { Snippet } from 'svelte';
  import type { Server } from '$lib/types/chat';
  import { chat } from '$lib/chat-state.svelte';
  import { notificationSettings } from '$lib/notification-settings.svelte';
  import { serverColor } from '$lib/server-color';
  import { sidebarFolds } from '$lib/sidebar-folds.svelte';

  import Avatar from './avatar.svelte';
  import CreateServerDialog from './create-server-dialog.svelte';
  import NotificationMenu from './notification-menu.svelte';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';

  let {
    servers,
    activeId,
    mentions,
    channels,
    onSelect,
    onCreateServer,
    onReorder,
  }: {
    servers: Server[];
    activeId: string | null;
    mentions: Record<string, number>;
    // renders one server's section: the server, whether it's unfolded and a toggle for that,
    // then whether it's kept in the sidebar and a toggle for that
    channels: Snippet<[Server, boolean, () => void, boolean, () => void]>;
    onSelect: (id?: string) => void;
    onCreateServer?: (server: Server) => void;
    onReorder?: (serverIds: string[]) => Promise<void>;
  } = $props();

  let createOpen = $state(false);
  let reordering = $state(false);

  // A server shows as a full section while you're in it or once you keep it (the pin); every
  // other server waits on the icon shelf, so the list stays short however many you've joined.
  // With a handful of servers they're all kept to begin with.
  const isPinned = (server: Server) => sidebarFolds.isOpen(`pin:${server.id}`, servers.length <= 5);
  const isSection = (server: Server) =>
    !server.down && (isPinned(server) || server.id === activeId);
  const isExpanded = (server: Server) => sidebarFolds.isOpen(server.id, true);

  const hasUnread = (serverId: string) =>
    (chat.channelsByServer[serverId] ?? []).some((category) =>
      category.channels.some(
        (channel) =>
          channel.unread &&
          notificationSettings.showsUnread({ channelId: channel.id, guildId: serverId })
      )
    );

  const flipDurationMs = 150;

  let orderedServers = $state<Server[]>(servers.filter((server) => server.id !== 'home'));

  /*
   * Keep local items synchronized when servers are added, removed, or updated,
   * without resetting the user's current ordering.
   */
  $effect(() => {
    const incomingServers = servers.filter((server) => server.id !== 'home');
    const incomingById = new Map(incomingServers.map((server) => [server.id, server]));

    const currentServers = untrack(() => orderedServers);

    const existingServers = currentServers
      .map((server) => incomingById.get(server.id))
      .filter((server): server is Server => server !== undefined);

    const existingIds = new Set(existingServers.map((server) => server.id));

    const newServers = incomingServers.filter((server) => !existingIds.has(server.id));

    orderedServers = [...existingServers, ...newServers];
  });

  // each drag zone needs its own list to shuffle; they're re-split whenever the order, the
  // pins or the server you're in change
  let sections = $state<Server[]>([]);
  let shelf = $state<Server[]>([]);
  $effect(() => {
    sections = orderedServers.filter(isSection);
    shelf = orderedServers.filter((server) => !isSection(server));
  });

  function handleConsider(zone: 'sections' | 'shelf', event: CustomEvent<DndEvent<Server>>) {
    if (zone === 'sections') sections = event.detail.items;
    else shelf = event.detail.items;
  }

  async function handleFinalize(zone: 'sections' | 'shelf', event: CustomEvent<DndEvent<Server>>) {
    handleConsider(zone, event);

    // the zone's servers keep their slots in the full order, just in their new sequence
    const moved = [...event.detail.items];
    const inZone = new Set(moved.map((server) => server.id));
    orderedServers = orderedServers.map((server) =>
      inZone.has(server.id) ? moved.shift()! : server
    );

    reordering = true;
    document.documentElement.classList.toggle('cursor-spinner', true);
    try {
      await onReorder?.(orderedServers.map((server) => server.id));
    } finally {
      document.documentElement.classList.toggle('cursor-spinner', false);
      reordering = false;
    }
  }
</script>

<div class="flex items-center justify-between px-5 pt-3 pb-1">
  <span class="text-xs font-medium text-muted-foreground select-none">Servers</span>
  <button
    class="cursor-pointer text-muted-foreground transition-colors hover:text-sidebar-foreground"
    aria-label="Add a server"
    title="Add a server"
    onclick={() => (createOpen = true)}
  >
    <Plus class="size-3.5" />
  </button>
</div>

<div
  class={reordering ? 'opacity-70' : ''}
  use:dndzone={{
    items: sections,
    flipDurationMs,
    type: 'server-sections',
    dropTargetStyle: {
      outline: 'none',
    },
  }}
  onconsider={(event) => handleConsider('sections', event)}
  onfinalize={(event) => handleFinalize('sections', event)}
  aria-label="Servers in the sidebar"
>
  {#each sections as server (server.id)}
    <div animate:flip={{ duration: flipDurationMs }}>
      {@render channels(
        server,
        isExpanded(server),
        () => sidebarFolds.set(server.id, !isExpanded(server)),
        isPinned(server),
        () => sidebarFolds.set(`pin:${server.id}`, !isPinned(server))
      )}
    </div>
  {/each}
</div>

<!-- the shelf: every other server as an icon, six to a row -->
<div
  class="grid grid-cols-6 gap-2 px-3 pt-2 empty:hidden {reordering ? 'opacity-70' : ''}"
  use:dndzone={{
    items: shelf,
    flipDurationMs,
    type: 'server-shelf',
    dropTargetStyle: {
      outline: 'none',
    },
  }}
  onconsider={(event) => handleConsider('shelf', event)}
  onfinalize={(event) => handleFinalize('shelf', event)}
  aria-label="Other servers"
>
  {#each shelf as server (server.id)}
    {@const mention = mentions[server.id] ?? 0}
    <div animate:flip={{ duration: flipDurationMs }} class="size-9 touch-none">
      <ContextMenu.Root>
        <ContextMenu.Trigger class="block size-full">
          <button
            class="relative block size-full cursor-pointer transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={server.down}
            title={server.down ? `${server.name} can't be reached right now` : server.name}
            aria-label={mention
              ? `${server.name}, ${mention} unread mention${mention === 1 ? '' : 's'}`
              : server.name}
            onclick={() => onSelect(server.id)}
          >
            <Avatar
              src={server.avatarUrl}
              name={server.name}
              fallback={server.initials}
              class="size-full text-xs"
              bgColor={server.avatarUrl ? undefined : serverColor(server.id)}
            />
            {#if mention > 0}
              <span
                class="absolute -right-1.5 -bottom-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-pill bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground ring-2 ring-sidebar"
              >
                {mention > 99 ? '99+' : mention}
              </span>
            {:else if hasUnread(server.id)}
              <span
                class="absolute -top-1 -right-1 size-3 rounded-pill bg-tertiary ring-2 ring-sidebar"
              ></span>
            {/if}
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Content class="w-56">
          <ContextMenu.Item onclick={() => sidebarFolds.set(`pin:${server.id}`, true)}>
            <Pin class="size-4" />
            Keep in sidebar
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <NotificationMenu targetId={server.id} noun="Server" />
        </ContextMenu.Content>
      </ContextMenu.Root>
    </div>
  {/each}
</div>

<CreateServerDialog bind:open={createOpen} onCreate={onCreateServer} />
