<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { flip } from 'svelte/animate';
  import { untrack } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';

  import type { Snippet } from 'svelte';
  import type { Server } from '$lib/types/chat';
  import { sidebarFolds } from '$lib/sidebar-folds.svelte';

  import CreateServerDialog from './create-server-dialog.svelte';

  let {
    servers,
    activeId,
    channels,
    onCreateServer,
    onReorder,
  }: {
    servers: Server[];
    activeId: string | null;
    // renders one server's section: the server, whether it's unfolded, and a toggle for that
    channels: Snippet<[Server, boolean, () => void]>;
    onCreateServer?: (server: Server) => void;
    onReorder?: (serverIds: string[]) => Promise<void>;
  } = $props();

  let createOpen = $state(false);
  let reordering = $state(false);

  // with a handful of servers everything stays open; with many, only the one you're in
  const isExpanded = (server: Server) =>
    !server.down && sidebarFolds.isOpen(server.id, servers.length <= 5 || server.id === activeId);

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
      {@render channels(server, isExpanded(server), () =>
        sidebarFolds.set(server.id, !isExpanded(server))
      )}
    </div>
  {/each}
</div>

<button
  class="mx-2 mt-1 flex h-9 w-[calc(100%-1rem)] cursor-pointer items-center gap-2.5 rounded-pill px-3 text-left text-sm font-medium text-primary transition-colors hover:bg-accent"
  onclick={() => (createOpen = true)}
>
  <Plus class="size-3.5 shrink-0" />
  Add a server
</button>

<CreateServerDialog bind:open={createOpen} onCreate={onCreateServer} />
