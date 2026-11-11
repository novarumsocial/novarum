<script lang="ts">
  import {
    Bot,
    ChevronRight,
    Hash,
    LoaderCircle,
    Phone,
    Plus,
    Users,
    X,
    IdCardLanyard,
  } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { dms, dmPath } from '$lib/dms.svelte';
  import { friends } from '$lib/friends.svelte';
  import { settings } from '$lib/settings.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { listConversations } from '$lib/conversations.svelte';
  import { sidebarFolds } from '$lib/sidebar-folds.svelte';
  import { tabs } from '$lib/tabs.svelte';
  import Avatar from './avatar.svelte';
  import NewDmDialog from './new-dm-dialog.svelte';
  import { notificationSettings } from '$lib/notification-settings.svelte';
  import NotificationMenu from './notification-menu.svelte';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';

  const entries = $derived(
    [...dms.list].sort(
      (a, b) =>
        new Date(b.lastMessageAt ?? b.joinedAt).getTime() -
        new Date(a.lastMessageAt ?? a.joinedAt).getTime()
    )
  );

  let { onCall }: { onCall?: (channelId: string) => void } = $props();

  let newDmOpen = $state(false);

  const UNREAD_LIMIT = 8;
  let showAllUnread = $state(false);
  const unread = $derived(
    listConversations()
      .filter((item) => (item.unread || item.mention > 0) && item.id !== chat.activeChannel)
      .sort((a, b) => b.mention - a.mention)
  );

  // The list shows the most recent few; anything unread or open always stays visible,
  // including while the section is folded.
  const RECENT = 6;
  let showAll = $state(false);
  const open = $derived(sidebarFolds.isOpen('dms', true));
  const isPinned = (entry: (typeof entries)[number]) =>
    (chat.route.kind === 'dms' && chat.route.channelId === entry.id) ||
    (entry.unread && notificationSettings.showsUnread({ channelId: entry.id, guildId: null }));
  const visible = $derived(
    entries.filter((entry, index) => isPinned(entry) || (open && (showAll || index < RECENT)))
  );

  const itemClass = (active: boolean) =>
    `flex h-9 w-full items-center gap-2.5 rounded-pill px-3 text-left text-sm transition-colors ${
      active
        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-sidebar-foreground'
    }`;
</script>

<section>
  <div class="space-y-0.5 px-2 py-2">
    <button class={itemClass(chat.route.kind === 'home')} onclick={() => goto('/guilds')}>
      <Users class="size-4 shrink-0" />
      <span class="flex-1 truncate">Friends</span>
      {#if friends.incoming.length > 0}
        <span
          class="flex h-4.5 min-w-4.5 items-center justify-center rounded-pill bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground"
          aria-label="{friends.incoming.length} pending friend requests"
        >
          {friends.incoming.length > 99 ? '99+' : friends.incoming.length}
        </span>
      {/if}
    </button>
    <button
      class={itemClass(chat.route.kind === 'developers')}
      onclick={() => goto('/guilds/developers')}
    >
      <Bot class="size-4 shrink-0" />
      <span class="flex-1 truncate">Developers</span>
    </button>

    <!-- everything waiting for you, from any server, so nothing hides below the fold -->
    {#if unread.length}
      <div class="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground select-none">Unread</div>
      {#each showAllUnread ? unread : unread.slice(0, UNREAD_LIMIT) as item (item.id)}
        <button
          class="{itemClass(false)} font-semibold text-sidebar-foreground"
          onclick={() => chat.selectChannel(item.id)}
        >
          {#if item.server}
            <Hash class="size-4 shrink-0" />
          {:else}
            <Avatar
              src={item.avatarUrl}
              name={item.name}
              class="size-5 text-[10px]"
              bgColor={item.avatarColor}
            />
          {/if}
          <span class="truncate">{item.name}</span>
          <span class="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
            {item.server?.name}
          </span>
          {#if item.mention > 0}
            <span
              class="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-pill bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground"
            >
              {item.mention > 99 ? '99+' : item.mention}
            </span>
          {:else}
            <span class="size-2 shrink-0 rounded-pill bg-tertiary"></span>
          {/if}
        </button>
      {/each}
      {#if unread.length > UNREAD_LIMIT}
        <button
          class="w-full cursor-pointer rounded-pill px-3 py-1.5 text-left text-xs font-medium text-primary hover:bg-accent"
          onclick={() => (showAllUnread = !showAllUnread)}
        >
          {showAllUnread ? 'Show fewer' : `Show ${unread.length - UNREAD_LIMIT} more`}
        </button>
      {/if}
    {/if}

    <div class="flex items-center justify-between px-3 pt-3 pb-1">
      <button
        class="flex flex-1 cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground transition-colors select-none hover:text-sidebar-foreground"
        aria-expanded={open}
        onclick={() => sidebarFolds.set('dms', !open)}
      >
        <ChevronRight class="size-3 shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
        Direct messages
        {#if !open && entries.length}<span class="tabular-nums">{entries.length}</span>{/if}
      </button>
      <button
        class="text-muted-foreground transition-colors hover:text-sidebar-foreground"
        aria-label="Start a direct message"
        onclick={() => (newDmOpen = true)}
      >
        <Plus class="size-3.5" />
      </button>
    </div>

    {#each visible as entry (entry.id)}
      {@const other = entry.participants[0]}
      {@const name = other ? other.displayName || other.username : 'Direct Message'}
      {@const active = chat.route.kind === 'dms' && chat.route.channelId === entry.id}
      {@const unread =
        entry.unread && notificationSettings.showsUnread({ channelId: entry.id, guildId: null })}
      <ContextMenu.Root>
        <ContextMenu.Trigger class="block">
          <div
            role="button"
            tabindex="0"
            class={itemClass(active) + ' group cursor-pointer'}
            onclick={() => goto(`/guilds/dms/${encodeURIComponent(entry.id)}`)}
            ondblclick={() => tabs.keep(entry.id)}
            onkeydown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                goto(`/guilds/dms/${encodeURIComponent(entry.id)}`);
              }
            }}
          >
            <div class="relative shrink-0">
              <Avatar
                src={other?.avatarUrl}
                {name}
                class="size-6 text-[10px]"
                bgColor={other?.avatarColor}
              />
              {#if other && friends.isOnline(other.userId)}
                <span
                  class="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-pill border-2 border-sidebar bg-online"
                ></span>
              {/if}
            </div>
            <span class="flex-1 truncate" class:font-semibold={unread}>{name}</span>
            {#if chat.voiceStates[entry.id]?.length}
              <Phone class="size-3.5 shrink-0 text-green-500" aria-label="In a call" />
            {/if}
            {#if unread}
              <span class="size-2 shrink-0 rounded-pill bg-tertiary"></span>
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
        </ContextMenu.Trigger>
        <ContextMenu.Content class="w-56">
          <NotificationMenu targetId={entry.id} noun="Conversation" />

          <ContextMenu.Separator />

          <ContextMenu.Item class="gap-2" onclick={() => dms.markRead(entry.id)}>
            Mark as read
          </ContextMenu.Item>

          <ContextMenu.Separator />

          <ContextMenu.Item onclick={() => console.log('not done')}>Profile</ContextMenu.Item>
          <ContextMenu.Item
            onclick={() => {
              void goto(dmPath(entry.id));
              onCall?.(entry.id);
            }}
          >
            Start a Call
          </ContextMenu.Item>
          <ContextMenu.Item
            onclick={() => {
              void dms.close(entry.id);
              if (active) void goto('/guilds/dms');
            }}
          >
            Close DM
          </ContextMenu.Item>

          {#if other && friends.isFriend?.(other.userId)}
            <ContextMenu.Item onclick={() => void friends.remove?.(other.userId)}>
              Remove Friend
            </ContextMenu.Item>
          {/if}

          <ContextMenu.Separator />

          <ContextMenu.Item
            class="gap-2"
            disabled={!other}
            onclick={() => other && navigator.clipboard.writeText(other.userId)}
          >
            <IdCardLanyard />
            Copy User ID
          </ContextMenu.Item>
          <ContextMenu.Item class="gap-2" onclick={() => navigator.clipboard.writeText(entry.id)}>
            <IdCardLanyard />
            Copy Channel ID
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
    {/each}

    {#if open && entries.length > visible.length}
      <button
        class="w-full cursor-pointer rounded-pill px-3 py-1.5 text-left text-xs font-medium text-primary hover:bg-accent"
        onclick={() => (showAll = true)}
      >
        Show {entries.length - visible.length} more
      </button>
    {:else if open && showAll && entries.length > RECENT}
      <button
        class="w-full cursor-pointer rounded-pill px-3 py-1.5 text-left text-xs font-medium text-primary hover:bg-accent"
        onclick={() => (showAll = false)}
      >
        Show fewer
      </button>
    {/if}

    {#each dms.pending as homeserver (homeserver)}
      <div class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground select-none">
        <LoaderCircle class="size-3.5 shrink-0 animate-spin" />
        <span class="flex-1 truncate">Waiting for {homeserver}…</span>
      </div>
    {/each}

    {#if entries.length === 0 && dms.pending.length === 0}
      <p class="pointer-events-none px-2 py-1 text-xs text-muted-foreground select-none">
        No conversations yet. Start one with the plus above.
      </p>
    {/if}
  </div>
</section>

<NewDmDialog bind:open={newDmOpen} />
