<script lang="ts">
  import { Bot, LoaderCircle, Phone, Plus, Users, X, IdCardLanyard } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { dms, dmPath } from '$lib/dms.svelte';
  import { friends } from '$lib/friends.svelte';
  import { settings } from '$lib/settings.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import Avatar from './avatar.svelte';
  import NewDmDialog from './new-dm-dialog.svelte';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { device } from '$lib/device.svelte';
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

  const itemClass = (active: boolean) =>
    `relative flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors ${
      active
        ? 'bg-sidebar-accent font-medium text-sidebar-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-beacon'
        : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
    }`;
</script>

<aside class="flex min-h-0 flex-1 flex-col">
  <div class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2" class:mt-2={device.isComputer}>
    {#if device.isComputer}
      <button class={itemClass(chat.route.kind === 'home')} onclick={() => goto('/guilds')}>
        <Users class="size-4 shrink-0" />
        <span class="flex-1 truncate">Friends</span>
      </button>
    {/if}
    <button
      class={itemClass(chat.route.kind === 'developers')}
      onclick={() => goto('/guilds/developers')}
    >
      <Bot class="size-4 shrink-0" />
      <span class="flex-1 truncate">Developers</span>
    </button>
    {#if device.isComputer}
      <Separator class="mt-3" />
    {/if}

    <div class="flex items-center justify-between px-2 pt-3 pb-1">
      <span class="text-xs font-semibold text-muted-foreground select-none"> Direct messages </span>
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
      {@const unread =
        entry.unread && notificationSettings.showsUnread({ channelId: entry.id, guildId: null })}
      <ContextMenu.Root>
        <ContextMenu.Trigger class="block">
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
              status={other && friends.isOnline(other.userId) ? 'online' : undefined}
            />
            <span class="flex-1 truncate" class:font-semibold={unread}>{name}</span>
            {#if chat.voiceStates[entry.id]?.length}
              <Phone class="size-3.5 shrink-0 text-green-500" aria-label="In a call" />
            {/if}
            {#if unread}
              <span
                class="size-2 shrink-0 bg-beacon"
                class:rounded-full={settings.value.circleIcons}
              ></span>
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

    {#each dms.pending as homeserver (homeserver)}
      <div class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground select-none">
        <LoaderCircle class="size-3.5 shrink-0 animate-spin" />
        <span class="flex-1 truncate">Waiting for {homeserver}…</span>
      </div>
    {/each}

    {#if entries.length === 0 && dms.pending.length === 0}
      <p
        class="pointer-events-none mt-4 flex items-center justify-center px-2 text-center text-xs text-muted-foreground select-none"
      >
        No conversations yet. Start one with the plus above.
      </p>
    {/if}
  </div>
</aside>

<NewDmDialog bind:open={newDmOpen} />
