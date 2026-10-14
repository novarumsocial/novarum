<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Check, Copy, RefreshCw, Search } from '@lucide/svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { chat } from '$lib/chat-state.svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { friends, type FriendEntry } from '$lib/friends.svelte';
  import { dms } from '$lib/dms.svelte';
  import Avatar from './avatar.svelte';

  let {
    open = $bindable(false),
    guildId = $bindable(''),
  }: {
    open: boolean;
    guildId: string;
  } = $props();

  let code = $state('');
  let copied = $state(false);
  let loading = $state(false);
  let query = $state('');
  let inviting = $state<string | null>(null);
  let invited = $state<string[]>([]);

  const inviteUrl = $derived(`${window.location.origin}/i/${code}@${anchor.homeServer}`);

  function nameFor(entry: FriendEntry) {
    return entry.user.displayName || entry.user.username;
  }

  function handleFor(entry: FriendEntry) {
    return `@${entry.user.username}:${entry.user.homeserver}`;
  }

  const visibleFriends = $derived(
    friends.accepted.filter((entry) => {
      if (chat.members.some((member) => member.userId === entry.user.userId)) return false;
      const q = query.trim().toLowerCase();
      return (
        !q || nameFor(entry).toLowerCase().includes(q) || handleFor(entry).toLowerCase().includes(q)
      );
    })
  );

  async function inviteFriend(entry: FriendEntry) {
    const userId = entry.user.userId;
    inviting = userId;
    const channelId = await dms.ensure(userId);
    if (channelId) {
      await chat.sendMessage(channelId, inviteUrl);
      invited = [...invited, userId];
    }
    inviting = null;
  }

  $effect(() => {
    if (open && code === '') {
      fetchInvite();
    }
  });

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl);
    copied = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    copied = false;
  }

  async function fetchInvite() {
    loading = true;
    const invite = await chat.getGuildInvite(guildId);
    if (invite) {
      code = invite.invite.code;
      // loading false here because createinvite will also do so
      loading = false;
    } else {
      await createInvite();
    }
  }
  async function createInvite() {
    loading = true;
    const invite = await chat.createGuildInvite(guildId);
    if (invite) {
      code = invite.invite.code;
    }
    loading = false;
  }

  async function regenerateInvite() {
    copied = false;
    invited = [];
    await createInvite();
  }

  function handleOpenChange() {
    if (!open) {
      copied = false;
      code = '';
      query = '';
      invited = [];
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Invite People</Dialog.Title>
      <Dialog.Description>
        Share this link to let people join the server. It's active indefinitely until regenerated.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      <div class="grid gap-1.5">
        <label for="invite-friends" class="text-xs font-medium text-foreground">
          Invite Friends
        </label>
        <div class="relative">
          <Search
            class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="invite-friends"
            bind:value={query}
            placeholder="Search friends"
            class="pl-8"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div class="max-h-56 space-y-0.5 overflow-y-auto">
          {#if friends.accepted.length === 0}
            <p class="py-6 text-center text-sm text-muted-foreground">
              You don't have any friends yet.
            </p>
          {:else if visibleFriends.length === 0}
            <p class="py-6 text-center text-sm text-muted-foreground">No matches.</p>
          {:else}
            {#each visibleFriends as entry (entry.user.userId)}
              {@const name = nameFor(entry)}
              {@const sent = invited.includes(entry.user.userId)}
              <div class="flex w-full items-center gap-2.5 px-2 py-1.5 text-sm">
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
                <Button
                  variant="outline"
                  size="sm"
                  disabled={inviting === entry.user.userId || sent || loading}
                  onclick={() => inviteFriend(entry)}
                >
                  {#if sent}
                    <Check class="size-4" />
                  {:else if inviting === entry.user.userId}
                    Inviting…
                  {:else}
                    Invite
                  {/if}
                </Button>
              </div>
            {/each}
          {/if}
        </div>
      </div>
      <label for="invite-link" class="text-xs font-medium text-foreground">Invite Link</label>
      <div class="flex gap-2">
        <Input id="invite-link" value={inviteUrl} readonly class="font-mono text-xs" />
        <Button
          variant="outline"
          size="icon"
          aria-label="Copy invite link"
          onclick={copyInvite}
          disabled={loading}
        >
          {#if copied}
            <Check class="size-4" />
          {:else}
            <Copy class="size-4" />
          {/if}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Copy invite link"
          onclick={regenerateInvite}
          disabled={loading}
        >
          <RefreshCw class="size-4" />
        </Button>
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
