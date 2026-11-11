<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { Server } from '$lib/types/chat';
  import Avatar from './avatar.svelte';

  // One server's heading in the sidebar tree: click to fold its channels away or back out.
  let {
    server,
    expanded,
    onToggle,
    unread = false,
    actions,
  }: {
    server: Server;
    expanded: boolean;
    onToggle: () => void;
    unread?: boolean;
    actions?: Snippet;
  } = $props();

  // servers without a picture get a steady colour of their own, picked from their id
  const TILES = [
    'oklch(0.55 0.16 292)',
    'oklch(0.58 0.15 8)',
    'oklch(0.58 0.11 200)',
    'oklch(0.6 0.13 65)',
    'oklch(0.56 0.13 150)',
    'oklch(0.55 0.15 255)',
  ];
  const tileColor = $derived(
    TILES[[...server.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TILES.length]
  );
</script>

<!-- sticks to the top of the sidebar while its channels scroll under it -->
<div class="sticky top-0 z-10 bg-sidebar px-2 py-px">
  <div class="group/server flex h-9 items-center rounded-pill pr-2 hover:bg-accent">
    <button
      type="button"
      class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-pill pl-2 text-left outline-none focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
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
        bgColor={server.avatarUrl ? undefined : tileColor}
      />
      <span
        class="truncate text-sm font-semibold {expanded || unread
          ? 'text-sidebar-foreground'
          : 'text-muted-foreground'}"
      >
        {server.name}
      </span>
    </button>

    {@render actions?.()}
  </div>
</div>
