<script lang="ts">
  import { Check, Menu, Search, Users, X, MessageSquare, EllipsisVertical } from '@lucide/svelte';
  import { z } from 'zod';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import type { FriendEntry } from '$lib/friends.svelte';
  import { friends } from '$lib/friends.svelte';
  import { dms } from '$lib/dms.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Button } from '$lib/components/ui/button';
  import Avatar from './avatar.svelte';
  import { settings } from '$lib/settings.svelte';
  import { cn } from '$lib/utils';

  let { onOpenNavigation }: { onOpenNavigation: () => void } = $props();

  let tab = $state<'online' | 'all' | 'pending' | 'add'>('online');
  let query = $state('');
  let handle = $state('');
  let addResult = $state<{ ok: boolean; message: string } | null>(null);

  // accepts "@name:server" or "name:server"
  const handleSchema = z
    .string()
    .trim()
    .regex(/^@?[^:\s@]+:\S+$/, 'Use a full handle, like @name:server.');

  function nameFor(entry: FriendEntry) {
    return entry.user.displayName || entry.user.username;
  }

  function handleFor(entry: FriendEntry) {
    return `@${entry.user.username}:${entry.user.homeserver}`;
  }

  function busy(id: string) {
    return friends.busyUserIds.includes(id);
  }

  async function sendRequest(event: SubmitEvent) {
    event.preventDefault();
    const parsed = handleSchema.safeParse(handle);
    if (!parsed.success) {
      addResult = { ok: false, message: parsed.error.issues[0].message };
      return;
    }
    const [username, homeserver] = parsed.data.replace(/^@/, '').split(/:(.*)/);
    const sent = await friends.request(parsed.data, username, homeserver);
    addResult = sent
      ? { ok: true, message: `Friend request sent to @${username}:${homeserver}.` }
      : { ok: false, message: friends.error ?? 'Could not send the friend request.' };
    if (sent) handle = '';
  }

  const online = $derived(friends.accepted.filter((e) => e.status === 'ONLINE'));
  const pendingCount = $derived(friends.incoming.length + friends.outgoing.length);
  const list = $derived(
    (tab === 'online' ? online : friends.accepted)
      .filter((entry) => {
        const q = query.trim().toLowerCase();
        return (
          !q ||
          nameFor(entry).toLowerCase().includes(q) ||
          handleFor(entry).toLowerCase().includes(q)
        );
      })
      .sort((a, b) => Number(b.status === 'ONLINE') - Number(a.status === 'ONLINE'))
  );
  const pending = $derived([
    ...friends.incoming.map((entry) => ({ entry, incoming: true })),
    ...friends.outgoing.map((entry) => ({ entry, incoming: false })),
  ]);
</script>

{#snippet person(entry: FriendEntry, subtitle: string, avatarClass = 'size-8')}
  {@const name = nameFor(entry)}
  <div class="relative shrink-0">
    <Avatar
      src={entry.user.avatarUrl}
      {name}
      class={cn(avatarClass, 'text-xs')}
      bgColor={entry.user.avatarColor}
    />
    <span
      class={cn(
        'absolute -right-1 -bottom-1 size-3.5 border-[3px] border-background group-hover:border-card',
        entry.status === 'ONLINE' ? 'bg-emerald-500' : 'bg-muted-foreground/60'
      )}
      class:rounded-full={settings.value.circleIcons}
    ></span>
  </div>
  <div class="min-w-0 flex-1 leading-tight select-none">
    <p class="truncate text-sm font-semibold">
      {name}
      <span class="ml-1 hidden text-xs font-normal text-muted-foreground group-hover:inline"
        >{handleFor(entry)}</span
      >
    </p>
    <p class="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
  </div>
{/snippet}

{#snippet action(label: string, onclick: () => void, Icon: typeof X, tone = '', disabled = false)}
  <Button
    variant="ghost"
    size="icon"
    class={cn('size-9 bg-card text-muted-foreground group-hover:bg-background', tone)}
    aria-label={label}
    title={label}
    {disabled}
    {onclick}
  >
    <Icon class="size-4" />
  </Button>
{/snippet}

{#snippet sectionLabel(text: string)}
  <h2 class="px-3 pt-4 pb-2 text-xs font-semibold text-muted-foreground select-none">
    {text}
  </h2>
{/snippet}

{#snippet empty(title: string, body: string)}
  <div class="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
    <Users class="size-10 text-muted-foreground/50" />
    <p class="mt-4 text-sm font-medium">{title}</p>
    <p class="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{body}</p>
  </div>
{/snippet}

<main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
  <Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
    <header class="flex h-12 shrink-0 items-center gap-4 border-b px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        class="md:hidden"
        onclick={onOpenNavigation}
        aria-label="Open channels"
      >
        <Menu class="size-5" />
      </Button>
      <div class="flex shrink-0 items-center gap-2 text-sm font-semibold">
        <Users class="size-5 text-muted-foreground" />
        <span class="hidden sm:inline">Friends</span>
      </div>
      <div class="h-6 w-px shrink-0 bg-border"></div>
      <Tabs.List class="h-auto min-w-0 justify-start gap-2 overflow-x-auto overflow-y-hidden bg-transparent p-0 [scrollbar-width:none]">
        {#each [{ value: 'online', label: 'Online' }, { value: 'all', label: 'All' }, { value: 'pending', label: 'Pending' }] as item (item.value)}
          <Tabs.Trigger
            value={item.value}
            class="h-7 flex-none gap-1.5 border-transparent! px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground data-active:bg-muted! data-active:text-foreground"
          >
            {item.label}
            {#if item.value === 'pending' && friends.incoming.length > 0}
              <span
                class="min-w-4 bg-destructive px-1 text-[11px] leading-4 font-bold text-white"
                class:rounded-full={settings.value.circleIcons}
              >
                {friends.incoming.length > 99 ? '99+' : friends.incoming.length}
              </span>
            {/if}
          </Tabs.Trigger>
        {/each}
        <Tabs.Trigger
          value="add"
          class="h-7 flex-none border-transparent! bg-primary! px-2.5 text-sm font-medium text-primary-foreground! hover:bg-primary/85! data-active:bg-transparent! data-active:text-sidebar-primary!"
        >
          Add friend
        </Tabs.Trigger>
      </Tabs.List>
    </header>

    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col overflow-y-auto px-3 pt-4 pb-6 sm:px-6">
        {#if tab === 'online' || tab === 'all'}
          {#if friends.loading && friends.accepted.length === 0}
            <p class="px-3 py-8 text-sm text-muted-foreground">Loading friends…</p>
          {:else if friends.accepted.length === 0}
            {@render empty(
              'No friends yet',
              'Add someone with their handle and they’ll show up here once they accept.'
            )}
            <Button class="mx-auto -mt-10 mb-16" onclick={() => (tab = 'add')}>Add friend</Button>
          {:else if tab === 'online' && online.length === 0}
            {@render empty(
              'No one’s around right now',
              'Friends who come online will show up here.'
            )}
          {:else}
            <div class="relative">
              <Input placeholder="Search" class="h-9 border-0 bg-sidebar pr-9" bind:value={query} />
              <Search
                class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>

            {@render sectionLabel(
              `${tab === 'online' ? 'Online' : 'All friends'} — ${list.length}`
            )}

            <div>
              {#each list as entry (entry.user.userId)}
                {@const name = nameFor(entry)}
                <div
                  class="group relative flex items-center gap-3 border-t px-3 py-2.5 hover:border-transparent hover:bg-card has-[button:focus-visible]:bg-card [&:hover+div]:border-transparent"
                >
                  <!-- the whole row opens the DM; the action buttons sit above it -->
                  <button
                    type="button"
                    class="absolute inset-0 cursor-pointer outline-none"
                    aria-label="Message {name}"
                    onclick={() => dms.open(entry.user.userId)}
                  ></button>
                  <div class="pointer-events-none flex min-w-0 flex-1 items-center gap-3">
                    {@render person(entry, entry.status === 'ONLINE' ? 'Online' : 'Offline')}
                  </div>
                  <div class="relative flex shrink-0 items-center gap-2">
                    {@render action(
                      `Message ${name}`,
                      () => dms.open(entry.user.userId),
                      MessageSquare
                    )}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                          <Button
                            {...props}
                            variant="ghost"
                            size="icon"
                            class="size-9 bg-card text-muted-foreground group-hover:bg-background"
                            aria-label="More options for {name}"
                            title="More"
                          >
                            <EllipsisVertical class="size-4" />
                          </Button>
                        {/snippet}
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content class="w-48" align="end">
                        <DropdownMenu.Item
                          variant="destructive"
                          disabled={busy(entry.user.userId)}
                          onclick={() => friends.remove(entry.user.userId)}
                        >
                          Remove friend
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  </div>
                </div>
              {:else}
                <p class="px-3 py-8 text-sm text-muted-foreground">
                  No friends match “{query.trim()}”.
                </p>
              {/each}
            </div>
          {/if}
        {:else if tab === 'pending'}
          {#if pending.length === 0}
            {@render empty(
              'No pending requests',
              'Requests you send or receive will wait here until they’re answered.'
            )}
          {:else}
            {@render sectionLabel(`Pending — ${pending.length}`)}
            <div>
              {#each pending as { entry, incoming } (entry.user.userId)}
                {@const name = nameFor(entry)}
                <div
                  class="group flex items-center gap-3 border-t px-3 py-2.5 hover:border-transparent hover:bg-card [&:hover+div]:border-transparent"
                >
                  {@render person(
                    entry,
                    incoming ? 'Incoming friend request' : 'Outgoing friend request'
                  )}
                  <div class="flex shrink-0 items-center gap-2">
                    {#if incoming}
                      {@render action(
                        `Accept ${name}`,
                        () => friends.accept(entry.user.userId),
                        Check,
                        'hover:text-emerald-500',
                        busy(entry.user.userId)
                      )}
                      {@render action(
                        `Ignore ${name}`,
                        () => friends.decline(entry.user.userId),
                        X,
                        'hover:text-destructive',
                        busy(entry.user.userId)
                      )}
                    {:else}
                      {@render action(
                        `Cancel request to ${name}`,
                        () => friends.remove(entry.user.userId),
                        X,
                        'hover:text-destructive',
                        busy(entry.user.userId)
                      )}
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <section class="border-b pb-6">
            <h2 class="text-base font-semibold">Add friend</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              You can add friends with their Novarum handle. It’s on their profile.
            </p>
            <form
              class={cn(
                'mt-4 flex items-center gap-2 border bg-sidebar p-1.5 pl-3 focus-within:border-ring',
                addResult && (addResult.ok ? 'border-emerald-500' : 'border-destructive')
              )}
              onsubmit={sendRequest}
            >
              <input
                bind:value={handle}
                oninput={() => (addResult = null)}
                placeholder="@name:server"
                aria-label="Friend's handle"
                autocomplete="off"
                spellcheck="false"
                class="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                {@attach (input) => input.focus()}
              />
              <Button type="submit" size="sm" disabled={!handle.trim()}>
                <span class="hidden sm:inline">Send friend request</span>
                <span class="sm:hidden">Send</span>
              </Button>
            </form>
            {#if addResult}
              <p
                class={cn('mt-2 text-xs', addResult.ok ? 'text-emerald-500' : 'text-destructive')}
                aria-live="polite"
              >
                {addResult.message}
              </p>
            {/if}
          </section>
          {@render empty(
            'Your friends will show up here',
            'Once someone accepts your request, you can message them from the Online and All tabs.'
          )}
        {/if}

        {#if friends.error && tab !== 'add'}
          <p class="my-4 border-l-2 border-destructive pl-3 text-xs leading-5 text-destructive">
            {friends.error}
          </p>
        {/if}
      </div>

      <aside class="hidden w-80 shrink-0 overflow-y-auto border-l p-4 xl:block">
        <h2 class="text-lg font-semibold">Active now</h2>
        {#if online.length === 0}
          <div class="mt-4 text-center">
            <p class="text-sm font-medium">It’s quiet for now…</p>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">
              When friends come online, they’ll show up here.
            </p>
          </div>
        {:else}
          <div class="mt-4 grid gap-2">
            {#each online as entry (entry.user.userId)}
              <button
                type="button"
                class="group flex w-full cursor-pointer items-center gap-3 border bg-sidebar p-3 text-left hover:bg-card"
                onclick={() => dms.open(entry.user.userId)}
              >
                {@render person(entry, 'Online', 'size-10')}
              </button>
            {/each}
          </div>
        {/if}
      </aside>
    </div>
  </Tabs.Root>
</main>
