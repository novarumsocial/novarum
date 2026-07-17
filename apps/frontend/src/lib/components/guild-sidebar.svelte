<script lang="ts">
  import { Compass, MessagesSquare, Plus } from '@lucide/svelte';
  import type { Server } from '$lib/types/chat';
  import CreateServerDialog from './create-server-dialog.svelte';
  import Avatar from './avatar.svelte';
  import { settings } from '$lib/settings.svelte';

  let {
    servers,
    activeId,
    mentions,
    onSelect,
    onCreateServer,
  }: {
    servers: Server[];
    activeId: string | null;
    mentions: Record<string, number>;
    onSelect: (id?: string) => void;
    onCreateServer?: (server: Server) => void;
  } = $props();
  let createOpen = $state(false);
</script>

<nav class="flex w-14 flex-col items-center gap-1.5 border-r border-border bg-background py-3">
  <button
    onclick={() => onSelect(undefined)}
    class="flex size-10 items-center justify-center text-base font-bold text-primary-foreground transition-opacity hover:opacity-80"
    class:opacity-70={activeId !== null}
    class:ring-2={activeId === null}
    class:ring-primary={activeId === null}
    class:ring-offset-1={activeId === null}
    class:ring-offset-background={activeId === null}
    class:rounded-full={settings.value.circleIcons}
    aria-label="Home"
  >
    <MessagesSquare class="size-5" />
  </button>
  <div class="my-0.5 h-px w-7 bg-border/50"></div>
  {#each servers as server}
    {#if server.id !== 'home'}
      <button
        onclick={() => onSelect(server.id)}
        class="relative flex size-10 items-center justify-center text-xs font-bold tracking-tight text-white transition-all hover:opacity-90 {server.down
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
            class="absolute -right-1.5 -bottom-1 flex min-w-4.5 h-4.5 items-center justify-center bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground ring-2 ring-background"
            class:rounded-full={settings.value.circleIcons}
          >
            {mentions[server.id] > 99 ? '99+' : mentions[server.id]}
          </span>
        {/if}
      </button>
    {/if}
  {/each}

  <div class="mt-auto flex flex-col items-center gap-1.5">
    <button
      class="flex size-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Discover servers"
    >
      <Compass class="size-5" />
    </button>
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
