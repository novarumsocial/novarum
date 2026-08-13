<script lang="ts">
  import {
    Check,
    Menu,
    Search,
    UserPlus,
    Users,
    X,
    MessageSquare,
    EllipsisVertical,
  } from '@lucide/svelte';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import type { FriendEntry } from '$lib/friends.svelte';
  import { friends } from '$lib/friends.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Button } from '$lib/components/ui/button';
  import Avatar from './avatar.svelte';
  import ProfileCard from './profile-card.svelte';
  import { settings } from '$lib/settings.svelte';

  let { onOpenNavigation }: { onOpenNavigation: () => void } = $props();

  let query = $state('');

  function nameFor(entry: FriendEntry) {
    return entry.user.displayName || entry.user.username;
  }

  function profileFor(entry: FriendEntry) {
    return { ...entry.user, server: entry.user.homeserver };
  }

  function busy(id: string) {
    return friends.busyUserIds.includes(id);
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
</script>

<main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
      <Button
        variant="ghost"
        size="icon-lg"
        class="mb-2 -ml-2 md:hidden"
        onclick={onOpenNavigation}
        aria-label="Open channels"
      >
        <Menu class="size-5" />
      </Button>
      <Tabs.Root value="people">
        <div class="flex items-center gap-2 border-b border-border">
          <Tabs.List variant="line" class="min-w-0 flex-1">
            <Tabs.Trigger value="people" class="cursor-pointer data-[state=active]:cursor-default">
              People
            </Tabs.Trigger>
            <Tabs.Trigger
              value="requests"
              class="cursor-pointer data-[state=active]:cursor-default"
            >
              Friend requests
              {#if friends.incoming.length > 0}
                <span
                  class="bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground"
                  class:rounded-full={settings.value.circleIcons}
                >
                  {friends.incoming.length > 99 ? '99+' : friends.incoming.length}
                </span>
              {/if}
            </Tabs.Trigger>
          </Tabs.List>
        </div>

        <Tabs.Content value="people" class="pt-4">
          <div class="relative">
            <Search
              class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input placeholder="Search people" class="pl-8" bind:value={query} />
          </div>

          {#if friends.loading && friends.accepted.length === 0}
            <div
              class="mt-6 border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
            >
              Loading friends...
            </div>
          {:else if friends.accepted.length === 0}
            <div class="mt-6 border border-dashed border-border px-6 py-12 text-center">
              <UserPlus class="mx-auto size-6 text-muted-foreground" />
              <p class="mt-3 text-sm font-medium">No friends yet</p>
              <p class="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                Open someone’s profile from a server member list or a message, then send them a
                friend request.
              </p>
            </div>
          {:else if visible.length === 0}
            <div class="mt-6 border border-dashed border-border px-6 py-12 text-center">
              <p class="text-sm font-medium">No matches for “{query.trim()}”</p>
              <p class="mt-1 text-xs text-muted-foreground">Try a different name or handle.</p>
            </div>
          {:else}
            <div class="mt-6 divide-y divide-border border-y border-border">
              {#each visible as entry (entry.user.userId)}
                {@const name = nameFor(entry)}
                <div class="flex items-center gap-3 py-2.5">
                  <!--<ProfileCard user={profileFor(entry)}>-->
                  <Avatar
                    src={entry.user.avatarUrl}
                    {name}
                    class="size-9 text-sm"
                    bgColor={entry.user.avatarColor}
                  />
                  <!--</ProfileCard>-->
                  <div class="min-w-0 flex-1 select-none">
                    <p class="truncate text-sm font-medium">{name}</p>
                    <p class="truncate font-mono text-[10px] text-muted-foreground">
                      {handleFor(entry)}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    class={settings.value.circleIcons ? 'rounded-full' : ''}
                  >
                    <MessageSquare />
                  </Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      {#snippet child({ props })}
                        <Button
                          {...props}
                          variant="secondary"
                          size="sm"
                          class={settings.value.circleIcons ? 'rounded-full' : ''}
                        >
                          <EllipsisVertical />
                        </Button>
                      {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content class="w-56" align="start">
                      <DropdownMenu.Group>
                        <DropdownMenu.Item>Start Video Call</DropdownMenu.Item>
                        <DropdownMenu.Item>Start Audio Call</DropdownMenu.Item>
                        <DropdownMenu.Item
                          variant="destructive"
                          disabled={busy(entry.user.userId)}
                          onclick={() => friends.remove(entry.user.userId)}
                          >Remove Friend
                        </DropdownMenu.Item>
                      </DropdownMenu.Group>
                      <DropdownMenu.Separator />
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div>
              {/each}
            </div>
          {/if}
        </Tabs.Content>

        <Tabs.Content value="requests" class="pt-4">
          {#if friends.incoming.length === 0 && friends.outgoing.length === 0}
            <div class="border border-dashed border-border px-6 py-12 text-center">
              <UserPlus class="mx-auto size-6 text-muted-foreground" />
              <p class="mt-3 text-sm font-medium">No friend requests</p>
              <p class="mt-1 text-xs text-muted-foreground">
                Requests you send or receive will show up here.
              </p>
            </div>
          {/if}

          {#if friends.incoming.length > 0}
            <h2
              class="mb-3 border-b border-border pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Incoming
            </h2>
            <div class="divide-y divide-border border-y border-border">
              {#each friends.incoming as entry (entry.user.userId)}
                {@const name = nameFor(entry)}
                <div class="flex items-center gap-3 py-2.5">
                  <Avatar
                    src={entry.user.avatarUrl}
                    {name}
                    class="size-9 text-sm"
                    bgColor={entry.user.avatarColor}
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">{name}</p>
                    <p class="truncate font-mono text-[10px] text-muted-foreground">
                      {handleFor(entry)}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="icon-sm"
                      aria-label="Accept friend request"
                      disabled={busy(entry.user.userId)}
                      onclick={() => friends.accept(entry.user.userId)}
                      class={settings.value.circleIcons ? 'rounded-full' : ''}
                    >
                      <Check class="size-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Decline friend request"
                      disabled={busy(entry.user.userId)}
                      onclick={() => friends.decline(entry.user.userId)}
                      class={settings.value.circleIcons ? 'rounded-full' : ''}
                    >
                      <X class="size-4" />
                    </Button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          {#if friends.outgoing.length > 0}
            <h2
              class="mb-3 mt-6 border-b border-border pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Sent
            </h2>
            <div class="divide-y divide-border border-y border-border">
              {#each friends.outgoing as entry (entry.user.userId)}
                {@const name = nameFor(entry)}
                <div class="flex items-center gap-3 py-2.5">
                  <Avatar
                    src={entry.user.avatarUrl}
                    {name}
                    class="size-9 text-sm"
                    bgColor={entry.user.avatarColor}
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">{name}</p>
                    <p class="truncate font-mono text-[10px] text-muted-foreground">
                      {handleFor(entry)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Cancel friend request"
                    disabled={busy(entry.user.userId)}
                    onclick={() => friends.remove(entry.user.userId)}
                    class={settings.value.circleIcons ? 'rounded-full' : ''}
                  >
                    <X class="size-4" />
                  </Button>
                </div>
              {/each}
            </div>
          {/if}
        </Tabs.Content>
      </Tabs.Root>

      {#if friends.error}
        <p class="mt-6 border-l-2 border-destructive pl-3 text-xs leading-5 text-destructive">
          {friends.error}
        </p>
      {/if}
    </div>
  </div>
</main>
