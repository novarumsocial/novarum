<script lang="ts">
  import { ChevronRight, Pin, PinOff } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { Server } from '$lib/types/chat';
  import { serverColor } from '$lib/server-color';
  import Avatar from './avatar.svelte';

  // One server's heading in the sidebar tree: click to fold its channels away or back out.
  let {
    server,
    expanded,
    onToggle,
    unread = false,
    pinned = true,
    onTogglePin,
    actions,
  }: {
    server: Server;
    expanded: boolean;
    onToggle: () => void;
    unread?: boolean;
    // an unpinned server only shows while you're in it, like a preview tab
    pinned?: boolean;
    onTogglePin?: () => void;
    actions?: Snippet;
  } = $props();
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
        bgColor={server.avatarUrl ? undefined : serverColor(server.id)}
      />
      <span
        class:italic={!pinned}
        class="truncate text-sm font-semibold {expanded || unread
          ? 'text-sidebar-foreground'
          : 'text-muted-foreground'}"
      >
        {server.name}
      </span>
    </button>

    {#if onTogglePin}
      <button
        type="button"
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-pill hover:bg-muted focus-visible:opacity-100 {pinned
          ? 'text-muted-foreground opacity-0 group-hover/server:opacity-100 hover:text-foreground'
          : 'text-primary'}"
        aria-pressed={pinned}
        aria-label={pinned
          ? `Stop keeping ${server.name} in the sidebar`
          : `Keep ${server.name} in the sidebar`}
        title={pinned ? 'Stop keeping in sidebar' : 'Keep in sidebar'}
        onclick={onTogglePin}
      >
        {#if pinned}<PinOff class="size-3.5" />{:else}<Pin class="size-3.5" />{/if}
      </button>
    {/if}
    {@render actions?.()}
  </div>
</div>
