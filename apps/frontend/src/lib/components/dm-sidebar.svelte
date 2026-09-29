<script lang="ts">
  import { Phone, Plus, Users, X } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { dms } from '$lib/dms.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import Avatar from './avatar.svelte';
  import NewDmDialog from './new-dm-dialog.svelte';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { device } from '$lib/device.svelte';

  const entries = $derived(
    [...dms.list].sort(
      (a, b) =>
        new Date(b.lastMessageAt ?? b.joinedAt).getTime() -
        new Date(a.lastMessageAt ?? a.joinedAt).getTime()
    )
  );

  let newDmOpen = $state(false);

  const itemClass = (active: boolean) =>
    `flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm transition-colors ${
      active
        ? 'bg-primary/10 text-sidebar-foreground'
        : 'text-muted-foreground hover:text-sidebar-foreground'
    }`;
</script>

<aside class="flex w-60 flex-col bg-sidebar">
  <div class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2" class:mt-2={device.isComputer}>
    {#if device.isComputer}
      <button class={itemClass(chat.route.kind === 'home')} onclick={() => goto('/guilds')}>
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
        aria-label="Start a direct message"
        onclick={() => (newDmOpen = true)}
      >
        <Plus class="size-3.5" />
      </button>
    </div>

    {#each entries as entry (entry.id)}
      {@const other = entry.participants[0]}
      {@const name = other ? other.displayName || other.username : 'Direct Message'}
      {@const active = chat.route.kind === 'dms' && chat.route.channelId === entry.id}
      <div
        role="button"
        tabindex="0"
        class={itemClass(active) + ' group cursor-pointer'}
        onclick={() => goto(`/guilds/dms/${encodeURIComponent(entry.id)}`)}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            goto(`/guilds/dms/${encodeURIComponent(entry.id)}`);
          }
        }}
      >
        <Avatar
          src={other?.avatarUrl}
          {name}
          class="size-6 text-[10px]"
          bgColor={other?.avatarColor}
        />
        <span class="flex-1 truncate" class:font-semibold={entry.unread}>{name}</span>
        {#if chat.voiceStates[entry.id]?.length}
          <Phone class="size-3.5 shrink-0 text-green-500" aria-label="In a call" />
        {/if}
        {#if entry.unread}
          <span class="size-1.5 shrink-0 rounded-full bg-primary"></span>
        {/if}
        <button
          class="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-sidebar-foreground group-hover:opacity-100"
          aria-label="Close direct message"
          onclick={(event) => {
            event.stopPropagation();
            void dms.close(entry.id);
            if (active) void goto('/guilds/dms');
          }}
        >
          <X class="size-3.5" />
        </button>
      </div>
    {/each}

    {#if entries.length === 0}
      <p
        class="pointer-events-none mt-4 flex items-center justify-center px-2 text-center text-xs text-muted-foreground select-none"
      >
        No direct messages yet. Start one from a friend's profile.
      </p>
    {/if}
  </div>
</aside>

<NewDmDialog bind:open={newDmOpen} />
