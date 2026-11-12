<script lang="ts">
  import BotBadge from './bot-badge.svelte';
  import { Users } from '@lucide/svelte';
  import type { Author } from '$lib/types/chat';
  import Avatar from './avatar.svelte';
  import ProfileCard from './profile-card.svelte';
  import type { Server } from '$lib/types/chat';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { chat } from '$lib/chat-state.svelte';
  import { dms } from '$lib/dms.svelte';
  import { friends } from '$lib/friends.svelte';

  let {
    server,
    members,
    onCall,
  }: {
    server: Server;
    members: Author[];
    onCall?: (channelId: string) => void;
  } = $props();

  const online = $derived(members.filter((member) => member.status !== 'OFFLINE'));
  const offline = $derived(members.filter((member) => member.status === 'OFFLINE'));

  function nameFor(member: Author) {
    return member.displayName || member.username;
  }

  async function openDm(member: Author) {
    const userId = friends.userIdFor(member.username, member.server);
    if (!userId) return;
    return await dms.open(userId);
  }

  function isFriend(member: Author) {
    return friends.statusFor(member.username, member.server) === 'FRIEND';
  }
</script>

{#snippet groupLabel(text: string, count: number, icon = false)}
  <div class="flex items-center gap-1 text-xs font-semibold text-muted-foreground select-none">
    {#if icon}<Users class="size-3.5" />{/if}
    {text} — {count}
  </div>
{/snippet}

<aside class="flex size-full w-56 flex-col border-l border-border bg-background">
  <header
    class="flex h-12 shrink-0 items-baseline gap-2 border-b border-border px-4 leading-[3rem] select-none"
  >
    <h1 class="text-[15px] font-bold tracking-tight">Members</h1>
    <span class="text-xs text-muted-foreground tabular-nums">{members.length}</span>
  </header>
  <div class="flex-1 space-y-2 overflow-y-auto px-3 py-4">
    {@render groupLabel('Online', online.length, true)}
    <div class="space-y-0.5">
      {#each online as member}
        {@const name = nameFor(member)}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            <ProfileCard
              user={member}
              {onCall}
              class="group flex w-full items-center gap-2.5 px-1 py-1 hover:bg-muted/50"
            >
              <!-- TODO: fix dependency for user.status -->
              <Avatar
                src={member.avatarUrl}
                {name}
                class="size-7 text-xs"
                bgColor={member.avatarColor}
                status="online"
              />
              <div class="flex min-w-0 flex-1">
                <span class="block truncate text-sm text-foreground">{name}</span>
                {#if member.isBot}<BotBadge class="mt-0.5 ml-1.5 shrink-0" />{/if}
                <span
                  class="block min-w-0 shrink-[100] truncate text-[10px] text-muted-foreground ml-1 mt-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ({member.server})
                </span>
              </div>
            </ProfileCard>
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            <ContextMenu.Item>Profile</ContextMenu.Item>
            <ContextMenu.Item onclick={() => chat.requestMention(member)}>Mention</ContextMenu.Item>
            {#if isFriend(member)}
              <ContextMenu.Item onclick={() => void openDm(member)}>Message</ContextMenu.Item>
              <!-- intentionally left out incase we wanna add personal notes like on signal -->
              <ContextMenu.Item
                onclick={() =>
                  void openDm(member).then((channelId) => {
                    if (channelId && onCall) onCall(channelId);
                  })}>Start a Call</ContextMenu.Item
              >
            {/if}
            <ContextMenu.Separator />
            <ContextMenu.Item>Mute</ContextMenu.Item>
            <ContextMenu.Item variant="destructive">Block</ContextMenu.Item>
            {#if server.canManageChannels}
              <ContextMenu.Separator />
              <ContextMenu.Item>Roles</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item variant="destructive">Kick {member.username}</ContextMenu.Item>
              <ContextMenu.Item variant="destructive">Ban {member.username}</ContextMenu.Item>
            {/if}
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    </div>

    {#if offline.length > 0}
      <div class="pt-3">{@render groupLabel('Offline', offline.length)}</div>
      <div class="space-y-0.5 opacity-50">
        {#each offline as member}
          {@const name = nameFor(member)}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <ProfileCard
                user={member}
                {onCall}
                class="group flex w-full items-center gap-2 px-1 py-1"
              >
                <div class="relative">
                  <Avatar
                    src={member.avatarUrl}
                    {name}
                    class="size-7 text-xs"
                    bgColor={member.avatarColor}
                  />
                </div>
                <div class="flex min-w-0 flex-1">
                  <span class="block truncate text-sm text-foreground">{name}</span>
                  <span
                    class="block min-w-0 shrink-[100] truncate text-[10px] text-muted-foreground ml-1 mt-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    ({member.server})
                  </span>
                </div>
                <!-- TODO: when hide online status is available => highlight user's profile with grey offline status circle -->
              </ProfileCard>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item>Profile</ContextMenu.Item>
              <ContextMenu.Item onclick={() => chat.requestMention(member)}
                >Mention</ContextMenu.Item
              >
              {#if isFriend(member)}
                <ContextMenu.Item onclick={() => void openDm(member)}>Message</ContextMenu.Item>
                <!-- intentionally left out Message from !isSelf incase we wanna add personal notes like on signal -->
                <ContextMenu.Item
                  onclick={() =>
                    void openDm(member).then((channelId) => {
                      if (channelId && onCall) onCall(channelId);
                    })}>Start a Call</ContextMenu.Item
                >
              {/if}
              <ContextMenu.Separator />
              <ContextMenu.Item>Mute</ContextMenu.Item>
              <ContextMenu.Item variant="destructive">Block</ContextMenu.Item>
              {#if server.canManageChannels}
                <ContextMenu.Separator />
                <ContextMenu.Item>Roles</ContextMenu.Item>
                <ContextMenu.Separator />
                <ContextMenu.Item variant="destructive">Kick {member.username}</ContextMenu.Item>
                <ContextMenu.Item variant="destructive">Ban {member.username}</ContextMenu.Item>
              {/if}
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      </div>
    {/if}
  </div>
</aside>
