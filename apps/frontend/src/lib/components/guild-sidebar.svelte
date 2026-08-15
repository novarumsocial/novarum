<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { flip } from 'svelte/animate';
  import { untrack } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';

  import type { Server } from '$lib/types/chat';
  import { settings } from '$lib/settings.svelte';

  import Avatar from './avatar.svelte';
  import CreateServerDialog from './create-server-dialog.svelte';

  let {
    servers,
    activeId,
    mentions,
    onSelect,
    onCreateServer,
    onReorder,
  }: {
    servers: Server[];
    activeId: string | null;
    mentions: Record<string, number>;
    onSelect: (id?: string) => void;
    onCreateServer?: (server: Server) => void;
    onReorder?: (serverIds: string[]) => Promise<void>;
  } = $props();

  let createOpen = $state(false);
  let reordering = $state(false);

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
    await onReorder?.(orderedServers.map((server) => server.id));
    document.documentElement.classList.toggle('cursor-spinner', false);
    reordering = false;
  }
</script>

<nav class="flex w-14 flex-col items-center gap-1.5 border-r border-border bg-background py-3">
  <button
    onclick={() => onSelect(undefined)}
    class="flex size-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
    class:opacity-70={activeId !== null}
    class:ring-2={activeId === null}
    class:ring-primary={activeId === null}
    class:ring-offset-1={activeId === null}
    class:ring-offset-background={activeId === null}
    class:rounded-full={settings.value.circleIcons}
    aria-label="Home"
  >
    <svg
      fill="currentColor"
      class="size-6.5"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M23,16a1,1,0,0,1-1,1H2a1,1,0,0,1,0-2H22A1,1,0,0,1,23,16Zm-5,5a1,1,0,0,0,0-2H6a1,1,0,0,0,0,2ZM7,12a1,1,0,0,0,2,0,3,3,0,0,1,6,0,1,1,0,0,0,2,0A5,5,0,0,0,7,12Zm4-7a1,1,0,0,0,2,0V4a1,1,0,0,0-2,0Zm7,7a1,1,0,0,0,1,1h1a1,1,0,0,0,0-2H19A1,1,0,0,0,18,12ZM4,11a1,1,0,0,0,0,2H5a1,1,0,0,0,0-2ZM5.636,5.636a1,1,0,0,0,0,1.414l.707.707A1,1,0,0,0,7.757,6.343L7.05,5.636A1,1,0,0,0,5.636,5.636Zm11.314,0-.707.707a1,1,0,1,0,1.414,1.414l.707-.707A1,1,0,1,0,16.95,5.636Z"
      />
    </svg>
  </button>

  <div class="my-0.5 h-px w-7 bg-border/50"></div>

  <div
    class={`flex flex-col items-center gap-1.5 ${reordering ? 'opacity-70' : ''}`}
    use:dndzone={{
      items: orderedServers,
      flipDurationMs,
      dropTargetStyle: {
        outline: 'none',
      },
    }}
    onconsider={handleConsider}
    onfinalize={handleFinalize}
    aria-label="Servers"
  >
    {#each orderedServers as server (server.id)}
      <div animate:flip={{ duration: flipDurationMs }} class="size-10 touch-none">
        <button
          onclick={() => onSelect(server.id)}
          class="cursor-pointer relative flex size-full items-center justify-center text-xs font-bold tracking-tight text-white transition-all hover:opacity-90 {server.down
            ? 'bg-destructive'
            : 'bg-primary'}"
          class:ring-2={activeId === server.id}
          class:ring-primary={activeId === server.id}
          class:ring-offset-1={activeId === server.id}
          class:ring-offset-background={activeId === server.id}
          class:opacity-60={activeId !== server.id}
          class:opacity-40={server.down}
          class:cursor-not-allowed={server.down}
          class:rounded-full={settings.value.circleIcons}
          disabled={server.down}
          aria-label={mentions[server.id]
            ? `${server.name}, ${mentions[server.id]} unread mention${mentions[server.id] === 1 ? '' : 's'}`
            : server.name}
        >
          <Avatar
            src={server.avatarUrl}
            name={server.name}
            fallback={server.initials}
            class="size-full bg-transparent text-xs text-primary-foreground"
            focused={activeId === server.id}
          />

          {#if mentions[server.id] > 0}
            <span
              class="absolute -right-1.5 -bottom-1 flex h-4.5 min-w-4.5 items-center justify-center bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground ring-2 ring-background"
              class:rounded-full={settings.value.circleIcons}
            >
              {mentions[server.id] > 99 ? '99+' : mentions[server.id]}
            </span>
          {/if}
        </button>
      </div>
    {/each}
  </div>

  <div class="mt-auto flex flex-col items-center gap-1.5">
    <button
      class="flex size-10 items-center justify-center border border-dashed border-muted-foreground/30 text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
      class:rounded-full={settings.value.circleIcons}
      aria-label="Add server"
      onclick={() => (createOpen = true)}
    >
      <Plus class="size-4" />
    </button>
  </div>
</nav>

<CreateServerDialog bind:open={createOpen} onCreate={onCreateServer} />
