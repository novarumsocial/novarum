<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import { flip } from 'svelte/animate';
  import { untrack } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';

  import type { Server } from '$lib/types/chat';
  import { goto } from '$app/navigation';
  import { dmPath, type DmEntry } from '$lib/dms.svelte';
  import { settings } from '$lib/settings.svelte';

  import Avatar from './avatar.svelte';
  import CreateServerDialog from './create-server-dialog.svelte';
  import NotificationMenu from './notification-menu.svelte';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';

  let {
    servers,
    activeId,
    mentions,
    unreadDms = [],
    friendRequests = 0,
    onSelect,
    onCreateServer,
    onReorder,
  }: {
    servers: Server[];
    activeId: string | null;
    mentions: Record<string, number>;
    unreadDms?: DmEntry[];
    friendRequests?: number;
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
    try {
      await onReorder?.(orderedServers.map((server) => server.id));
    } finally {
      document.documentElement.classList.toggle('cursor-spinner', false);
      reordering = false;
    }
  }
</script>

{#snippet activeBar()}
  <span class="absolute inset-x-0 -bottom-1.5 h-0.5 bg-beacon" aria-hidden="true"></span>
{/snippet}

{#snippet badge(count: number)}
  <span
    class="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground ring-2 ring-sidebar"
    class:rounded-full={settings.value.circleIcons}
  >
    {count > 99 ? '99+' : count}
  </span>
{/snippet}

<nav class="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
  <div class="flex items-center gap-2">
    <button
      onclick={() => onSelect(undefined)}
      class="relative flex h-9 cursor-pointer items-center gap-2 bg-sidebar-accent pr-3 pl-2 text-sm font-medium transition-colors {activeId ===
      null
        ? 'text-sidebar-foreground'
        : 'text-muted-foreground hover:text-foreground'}"
      class:rounded-full={settings.value.circleIcons}
      aria-label={friendRequests
        ? `Home, ${friendRequests} pending friend request${friendRequests === 1 ? '' : 's'}`
        : 'Home'}
    >
      <svg
        fill="currentColor"
        class="size-5.5 {activeId === null ? 'text-beacon' : ''}"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M23,16a1,1,0,0,1-1,1H2a1,1,0,0,1,0-2H22A1,1,0,0,1,23,16Zm-5,5a1,1,0,0,0,0-2H6a1,1,0,0,0,0,2ZM7,12a1,1,0,0,0,2,0,3,3,0,0,1,6,0,1,1,0,0,0,2,0A5,5,0,0,0,7,12Zm4-7a1,1,0,0,0,2,0V4a1,1,0,0,0-2,0Zm7,7a1,1,0,0,0,1,1h1a1,1,0,0,0,0-2H19A1,1,0,0,0,18,12ZM4,11a1,1,0,0,0,0,2H5a1,1,0,0,0,0-2ZM5.636,5.636a1,1,0,0,0,0,1.414l.707.707A1,1,0,0,0,7.757,6.343L7.05,5.636A1,1,0,0,0,5.636,5.636Zm11.314,0-.707.707a1,1,0,1,0,1.414,1.414l.707-.707A1,1,0,1,0,16.95,5.636Z"
        />
      </svg>
      Home
      {#if activeId === null}{@render activeBar()}{/if}
      {#if friendRequests > 0}{@render badge(friendRequests)}{/if}
    </button>

    <div class="flex min-w-0 flex-1 gap-2 overflow-hidden py-1.5 pr-1.5">
      {#each unreadDms as dm (dm.id)}
        {@const other = dm.participants[0]}
        {@const name = other ? other.displayName || other.username : 'Direct Message'}
        <button
          onclick={() => goto(dmPath(dm.id))}
          class="relative size-9 shrink-0 cursor-pointer transition-opacity hover:opacity-90"
          aria-label="{name}, unread direct message"
          title={name}
        >
          <Avatar
            src={other?.avatarUrl}
            {name}
            class="size-full text-xs"
            bgColor={other?.avatarColor}
          />
          <span
            class="absolute -top-1 -right-1 size-2.5 bg-destructive ring-2 ring-sidebar"
            class:rounded-full={settings.value.circleIcons}
          ></span>
        </button>
      {/each}
    </div>

    <button
      class="flex size-9 shrink-0 items-center justify-center border border-dashed border-muted-foreground/40 text-muted-foreground transition-colors hover:border-beacon hover:text-beacon"
      class:rounded-full={settings.value.circleIcons}
      title="Add server"
      aria-label="Add server"
      onclick={() => (createOpen = true)}
    >
      <Plus class="size-4" />
    </button>
  </div>

  <!-- a plain six-column grid so any number of servers wraps into even rows; past three rows it scrolls.
       The negative margin + padding keeps badges and the active bar from being clipped. -->
  <div
    class={`-m-1.5 grid max-h-34 grid-cols-6 content-start gap-2 overflow-y-auto p-1.5 empty:hidden ${reordering ? 'opacity-70' : ''}`}
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
      <div animate:flip={{ duration: flipDurationMs }} class="size-9 touch-none">
        <ContextMenu.Root>
          <ContextMenu.Trigger class="block size-full">
            <button
              onclick={() => onSelect(server.id)}
              class="relative flex size-full cursor-pointer items-center justify-center text-xs font-bold transition-colors {server.down
                ? 'bg-destructive text-destructive-foreground'
                : activeId === server.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-sidebar-accent text-muted-foreground hover:text-foreground'}"
              class:opacity-40={server.down}
              class:cursor-not-allowed={server.down}
              class:rounded-full={settings.value.circleIcons}
              disabled={server.down}
              title={server.name}
              aria-label={mentions[server.id]
                ? `${server.name}, ${mentions[server.id]} unread mention${mentions[server.id] === 1 ? '' : 's'}`
                : server.name}
            >
              <Avatar
                src={server.avatarUrl}
                name={server.name}
                fallback={server.initials}
                class="size-full bg-transparent text-xs text-inherit"
                focused={activeId === server.id}
              />
              {#if activeId === server.id}{@render activeBar()}{/if}
              {#if mentions[server.id] > 0}{@render badge(mentions[server.id])}{/if}
            </button>
          </ContextMenu.Trigger>
          <ContextMenu.Content class="w-56">
            <NotificationMenu targetId={server.id} noun="Server" />
          </ContextMenu.Content>
        </ContextMenu.Root>
      </div>
    {/each}
  </div>
</nav>

<CreateServerDialog bind:open={createOpen} onCreate={onCreateServer} />
