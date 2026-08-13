<script lang="ts">
  import { Plus, Users } from '@lucide/svelte';
  import { friends } from '$lib/friends.svelte';
  import Avatar from './avatar.svelte';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { device } from '$lib/device.svelte';

  const entries = $derived(
    [...friends.accepted].sort(
      (b, a) =>
        new Date(a.acceptedAt ?? a.createdAt).getTime() -
        new Date(b.acceptedAt ?? b.createdAt).getTime()
    )
  );

  // ponytail: selection is visual only, no DM backend yet — wire to chat route when DMs exist
  let selected = $state<string | null>('friends');

  const itemClass = (id: string) =>
    `flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm transition-colors ${
      selected === id
        ? 'bg-primary/10 text-sidebar-foreground'
        : 'text-muted-foreground hover:text-sidebar-foreground'
    }`;
</script>

<aside class="flex w-60 flex-col bg-sidebar">
  <div class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2 mt-2">
    {#if device.isComputer}
      <button class={itemClass('friends')} onclick={() => (selected = 'friends')}>
        <Users class="size-4 shrink-0" />
        <span class="flex-1 truncate">Friends</span>
      </button>

      <Separator class="mt-3" />
    {/if}

    <div class="flex items-center justify-between px-2 pt-3 pb-1">
      <span
        class="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none"
      >
        Direct Messages
      </span>
      <button
        class="text-muted-foreground transition-colors hover:text-sidebar-foreground"
        aria-label="Create direct message"
      >
        <Plus class="size-3.5" />
      </button>
    </div>

    {#each entries as entry (entry.user.userId)}
      {@const name = entry.user.displayName || entry.user.username}
      <button class={itemClass(entry.user.userId)} onclick={() => (selected = entry.user.userId)}>
        <Avatar
          src={entry.user.avatarUrl}
          {name}
          class="size-6 text-[10px]"
          bgColor={entry.user.avatarColor}
        />
        <span class="flex-1 truncate">{name}</span>
      </button>
    {/each}
  </div>
</aside>
