<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Check, Search } from '@lucide/svelte';
  import { friends, type FriendEntry } from '$lib/friends.svelte';
  import { dms, type DmEntry } from '$lib/dms.svelte';
  import { anchor } from '$lib/anchor.svelte';
  import Avatar from './avatar.svelte';

  // without `addTo`, one friend opens a 1:1 and more start a group. With a group, the picked
  // friends join it; with a 1:1, a new group starts with the other person and the picked friends.
  let { open = $bindable(false), addTo = null }: { open: boolean; addTo?: DmEntry | null } =
    $props();

  let query = $state('');
  let selected = $state<string[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const inGroup = $derived(new Set(addTo?.participants.map((user) => user.userId) ?? []));
  const limit = $derived(anchor.maxGroupMembers);
  const taken = $derived(addTo ? addTo.participants.length + 1 : 1);
  const room = $derived(limit - taken);

  function nameFor(entry: FriendEntry) {
    return entry.user.displayName || entry.user.username;
  }

  function handleFor(entry: FriendEntry) {
    return `@${entry.user.username}:${entry.user.homeserver}`;
  }

  const visible = $derived(
    friends.accepted.filter((entry) => {
      if (inGroup.has(entry.user.userId)) return false;
      const q = query.trim().toLowerCase();
      return (
        !q || nameFor(entry).toLowerCase().includes(q) || handleFor(entry).toLowerCase().includes(q)
      );
    })
  );

  function toggle(userId: string) {
    error = null;
    if (selected.includes(userId)) selected = selected.filter((id) => id !== userId);
    else if (selected.length < room) selected = [...selected, userId];
  }

  async function submit() {
    if (!selected.length) return;
    busy = true;
    error = null;
    const ids = selected;
    let failed: string | null = null;
    if (addTo?.type === 'GROUP_DM') {
      failed = await dms.addMembers(addTo.id, ids);
    } else if (addTo) {
      const other = addTo.participants[0];
      failed = (await dms.createGroup([...(other ? [other.userId] : []), ...ids])).error ?? null;
    } else if (ids.length === 1) {
      await dms.open(ids[0]!);
    } else {
      failed = (await dms.createGroup(ids)).error ?? null;
    }
    busy = false;
    if (failed) return void (error = failed);
    open = false;
  }

  function handleOpenChange() {
    if (open) return;
    query = '';
    selected = [];
    error = null;
  }

  const title = $derived(addTo ? 'Add People' : 'New Message');
  const action = $derived(
    addTo?.type === 'GROUP_DM'
      ? 'Add to Group'
      : addTo || selected.length > 1
        ? 'Create Group'
        : 'Open DM'
  );
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header class="select-none">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>
        {addTo
          ? `Pick friends to add. ${room} more can join.`
          : `Pick a friend, or several to start a group of up to ${limit}.`}
      </Dialog.Description>
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
          {@const checked = selected.includes(entry.user.userId)}
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            class="flex w-full items-center gap-2.5 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
            disabled={busy || (!checked && selected.length >= room)}
            onclick={() => toggle(entry.user.userId)}
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
            <span
              class="flex size-4 shrink-0 items-center justify-center border border-border"
              class:bg-primary={checked}
              class:border-primary={checked}
            >
              {#if checked}<Check class="size-3 text-primary-foreground" />{/if}
            </span>
          </button>
        {/each}
      {/if}
    </div>

    {#if error}<p class="text-xs text-destructive">{error}</p>{/if}

    <Dialog.Footer>
      <Button disabled={busy || !selected.length} onclick={submit}>
        {action}{selected.length > 1 ? ` (${selected.length})` : ''}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
