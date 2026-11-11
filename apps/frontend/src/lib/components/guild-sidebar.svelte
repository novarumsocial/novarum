<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { flip } from 'svelte/animate';
  import { untrack } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';

  import { z } from 'zod';
  import type { Snippet } from 'svelte';
  import type { Server } from '$lib/types/chat';
  import { chat } from '$lib/chat-state.svelte';
  import { notificationSettings } from '$lib/notification-settings.svelte';

  import ServerRow from './server-row.svelte';
  import CreateServerDialog from './create-server-dialog.svelte';
  import NotificationMenu from './notification-menu.svelte';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';

  let {
    servers,
    activeId,
    mentions,
    channels,
    onCreateServer,
    onReorder,
  }: {
    servers: Server[];
    activeId: string | null;
    mentions: Record<string, number>;
    // renders one unfolded server; the second argument folds it again
    channels: Snippet<[Server, () => void]>;
    onCreateServer?: (server: Server) => void;
    onReorder?: (serverIds: string[]) => Promise<void>;
  } = $props();

  let createOpen = $state(false);
  let reordering = $state(false);

  // Servers the user folded or unfolded by hand. Anything else follows the default below.
  const FOLD_KEY = 'novarum:server-folds';
  function loadFolds() {
    try {
      const stored = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}');
      return z.record(z.string(), z.boolean()).parse(stored);
    } catch {
      return {};
    }
  }
  let folds = $state(loadFolds());

  // with a handful of servers everything stays open; with many, only the one you're in
  const isExpanded = (server: Server) =>
    !server.down && (folds[server.id] ?? (servers.length <= 5 || server.id === activeId));

  function toggle(server: Server) {
    folds = { ...folds, [server.id]: !isExpanded(server) };
    localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
  }

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

  function handleConsider(event: CustomEvent<DndEvent<Server>>) {
    orderedServers = event.detail.items;
  }

  async function handleFinalize(event: CustomEvent<DndEvent<Server>>) {
    orderedServers = event.detail.items;

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

<div
  class={reordering ? 'opacity-70' : ''}
  use:dndzone={{
    items: orderedServers,
    flipDurationMs,
    type: 'servers',
    dropTargetStyle: {
      outline: 'none',
    },
  }}
  onconsider={handleConsider}
  onfinalize={handleFinalize}
  aria-label="Servers"
>
  {#each orderedServers as server (server.id)}
    <div animate:flip={{ duration: flipDurationMs }}>
      {#if isExpanded(server)}
        {@render channels(server, () => toggle(server))}
      {:else}
        <ContextMenu.Root>
          <ContextMenu.Trigger class="block">
            <ServerRow
              {server}
              expanded={false}
              onToggle={() => toggle(server)}
              unread={hasUnread(server.id)}
              mention={mentions[server.id] ?? 0}
            />
          </ContextMenu.Trigger>
          <ContextMenu.Content class="w-56">
            <NotificationMenu targetId={server.id} noun="Server" />
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/if}
    </div>
  {/each}
</div>

<button
  class="mt-1 flex h-9 w-full cursor-pointer items-center gap-2 pl-3 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
  onclick={() => (createOpen = true)}
>
  <Plus class="size-3.5 shrink-0" />
  Add a server
</button>

<CreateServerDialog bind:open={createOpen} onCreate={onCreateServer} />
