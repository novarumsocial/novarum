<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Search } from '@lucide/svelte';
  import { friends, type FriendEntry } from '$lib/friends.svelte';
  import { dms } from '$lib/dms.svelte';
  import Avatar from './avatar.svelte';

  let { open = $bindable(false) }: { open: boolean } = $props();

  let query = $state('');
  let opening = $state<string | null>(null);

  function nameFor(entry: FriendEntry) {
    return entry.user.displayName || entry.user.username;
  }

  function handleFor(entry: FriendEntry) {
    return `@${entry.user.username}:${entry.user.homeserver}`;
  }

  const visible = $derived(
    friends.accepted.filter((entry) => {
      const q = query.trim().toLowerCase();
      return (
        !q || nameFor(entry).toLowerCase().includes(q) || handleFor(entry).toLowerCase().includes(q)
      );
    })
  );

  async function handleSelect(entry: FriendEntry) {
    opening = entry.user.userId;
    await dms.open(entry.user.userId);
    opening = null;
    open = false;
    query = '';
  }

  function handleOpenChange() {
    if (!open) query = '';
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header class="select-none">
      <Dialog.Title>New Direct Message</Dialog.Title>
      <Dialog.Description>Pick a friend to message.</Dialog.Description>
    </Dialog.Header>

    <div class="relative">
      <Search
        class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        bind:value={query}
        placeholder="Search friends"
        class="pl-8"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="max-h-72 space-y-0.5 overflow-y-auto">
      {#if friends.accepted.length === 0}
        <p class="py-6 text-center text-sm text-muted-foreground">
          You don't have any friends yet.
        </p>
      {:else if visible.length === 0}
        <p class="py-6 text-center text-sm text-muted-foreground">No matches.</p>
      {:else}
        {#each visible as entry (entry.user.userId)}
          {@const name = nameFor(entry)}
          <button
            type="button"
            class="flex w-full items-center gap-2.5 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
            disabled={opening === entry.user.userId}
            onclick={() => handleSelect(entry)}
          >
            <Avatar
              src={entry.user.avatarUrl}
              {name}
              class="size-8 text-xs"
              bgColor={entry.user.avatarColor}
            />
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{name}</p>
              <p class="truncate font-mono text-[10px] text-muted-foreground">
                {handleFor(entry)}
              </p>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
