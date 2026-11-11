<script lang="ts">
  import { Pin, Plus } from '@lucide/svelte';
  import { flip } from 'svelte/animate';
  import { tick, untrack } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';

  import type { Snippet } from 'svelte';
  import type { Server } from '$lib/types/chat';
  import { chat } from '$lib/chat-state.svelte';
  import { notificationSettings } from '$lib/notification-settings.svelte';
  import { serverColor } from '$lib/server-color';
  import { settings } from '$lib/settings.svelte';
  import { sidebarFolds } from '$lib/sidebar-folds.svelte';

  import Avatar from './avatar.svelte';
  import CreateServerDialog from './create-server-dialog.svelte';
  import NotificationMenu from './notification-menu.svelte';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';

  let {
    servers,
    activeId,
    mentions,
    top,
    channels,
    onSelect,
    onCreateServer,
    onReorder,
  }: {
    servers: Server[];
    activeId: string | null;
    mentions: Record<string, number>;
    // whatever sits above the servers in the scrolling part of the sidebar
    top: Snippet;
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
    sections = orderedServers.filter((server) => !server.down && isPinned(server));
    shelf = orderedServers.filter((server) => server.down || !isPinned(server));
  });

  // The server you're in, when it isn't kept: its channels open in a fixed spot above the shelf
  // and its icon stays where it was, so nothing reshuffles as you move between servers.
  const visiting = $derived(shelf.find((server) => server.id === activeId && !server.down));

  let list = $state<HTMLElement>();
  $effect(() => {
    if (!activeId) return;
    void tick().then(() =>
      list
        ?.querySelector(`[data-server="${CSS.escape(activeId)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    );
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

<div class="flex min-h-0 flex-1 flex-col">
  <div bind:this={list} class="min-h-0 flex-1 overflow-y-auto pb-2">
    {@render top()}
    {#if sections.length}<div class="mx-5 mt-3 mb-2 h-px bg-border"></div>{/if}
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
        <div animate:flip={{ duration: flipDurationMs }} data-server={server.id}>
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
  </div>

  <!-- the server you're visiting opens right above the shelf it came from -->
  {#if visiting}
    <div
      data-server={visiting.id}
      class="max-h-[45%] shrink-0 overflow-y-auto border-t border-border pt-1"
    >
      {@render channels(
        visiting,
        isExpanded(visiting),
        () => sidebarFolds.set(visiting.id, !isExpanded(visiting)),
        false,
        () => sidebarFolds.set(`pin:${visiting.id}`, true)
      )}
    </div>
  {/if}

  <!-- and the shelf itself stays put at the bottom, whatever the list above it is doing -->
  <div class="shrink-0 border-t border-border pb-2.5">
    <div class="flex items-center justify-between px-5 pt-2.5 pb-0.5">
      <span class="text-xs font-medium text-muted-foreground select-none">
        {sections.length ? 'More servers' : 'Servers'}
      </span>
      <button
        class="cursor-pointer text-muted-foreground transition-colors hover:text-sidebar-foreground"
        aria-label="Add a server"
        title="Add a server"
        onclick={() => (createOpen = true)}
      >
        <Plus class="size-3.5" />
      </button>
    </div>

    <!-- every server that isn't a section above, as an icon, six to a row -->
    <div
      class="grid max-h-36 grid-cols-6 gap-2 overflow-y-auto px-3 py-2 empty:hidden {reordering
        ? 'opacity-70'
        : ''}"
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
              <Tooltip.Root>
                <Tooltip.Trigger
                  class="relative block size-full cursor-pointer transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40 {server.id ===
                  activeId
                    ? 'outline-2 outline-offset-2 outline-primary'
                    : ''} {settings.value.circleIcons ? 'rounded-full' : ''}"
                  aria-current={server.id === activeId ? 'page' : undefined}
                  disabled={server.down}
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
                </Tooltip.Trigger>
                <Tooltip.Content side="top">
                  {server.down ? `${server.name} can't be reached right now` : server.name}
                </Tooltip.Content>
              </Tooltip.Root>
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
  </div>
</div>

<CreateServerDialog bind:open={createOpen} onCreate={onCreateServer} />
