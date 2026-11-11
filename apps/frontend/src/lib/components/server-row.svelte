<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { Server } from '$lib/types/chat';
  import { settings } from '$lib/settings.svelte';
  import Avatar from './avatar.svelte';

  // One server's heading in the sidebar tree: click to fold its channels away or back out.
  let {
    server,
    expanded,
    onToggle,
    unread = false,
    mention = 0,
    actions,
  }: {
    server: Server;
    expanded: boolean;
    onToggle: () => void;
    unread?: boolean;
    mention?: number;
    actions?: Snippet;
  } = $props();
</script>

<div class="group/server flex h-9 items-center pr-2 hover:bg-sidebar-accent/60">
  <button
    type="button"
    class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pl-3 text-left outline-none focus-visible:bg-sidebar-accent disabled:cursor-not-allowed disabled:opacity-40"
    aria-expanded={expanded}
    disabled={server.down}
    title={server.down ? `${server.name} can't be reached right now` : undefined}
    onclick={onToggle}
  >
    <ChevronRight
      class="size-3.5 shrink-0 text-muted-foreground transition-transform {expanded
        ? 'rotate-90'
        : ''}"
    />
    <Avatar
      src={server.avatarUrl}
      name={server.name}
      fallback={server.initials.charAt(0)}
      class="size-5 text-[10px]"
    />
    <span
      class="truncate text-sm font-semibold {expanded || unread || mention > 0
        ? 'text-sidebar-foreground'
        : 'text-muted-foreground'}"
    >
      {server.name}
    </span>
  </button>

  {#if mention > 0}
    <span
      class="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground"
      class:rounded-full={settings.value.circleIcons}
    >
      {mention > 99 ? '99+' : mention}
    </span>
  {:else if unread}
    <span
      class="mx-1.5 size-2 shrink-0 bg-foreground"
      class:rounded-full={settings.value.circleIcons}
    ></span>
  {/if}

  {@render actions?.()}
</div>
