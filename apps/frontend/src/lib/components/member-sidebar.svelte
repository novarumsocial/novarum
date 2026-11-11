<script lang="ts">
  import BotBadge from './bot-badge.svelte';
  import type { Author } from '$lib/types/chat';
  import Avatar from './avatar.svelte';
  import ProfileCard from './profile-card.svelte';
  import { settings } from '$lib/settings.svelte';
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

{#snippet groupLabel(text: string, count: number)}
  <h2 class="flex items-baseline justify-between px-1 text-xs font-medium text-muted-foreground">
    {text}
    <span class="tabular-nums">{count}</span>
  </h2>
{/snippet}

<aside class="flex size-full w-56 flex-col border-l border-border bg-background">
  <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
    <h1 class="text-[15px] font-semibold">Members</h1>
    <span class="text-xs text-muted-foreground tabular-nums">{members.length}</span>
  </header>
  <div class="flex-1 space-y-2 overflow-y-auto px-3 py-4">
    {@render groupLabel('Online', online.length)}
    <div class="space-y-0.5">
      {#each online as member}
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
                <span
                  class="absolute -bottom-px -right-px size-2.5 border-2 border-background bg-online"
                ></span>
                {#if settings.value.circleIcons}
                  <span
                    class="rounded-full absolute -bottom-px -right-px size-2.75 border-2 border-background bg-online"
                  ></span>
                {/if}
                <!-- TODO: fix dependency for user.status -->
              </div>
              <div class="flex min-w-0 flex-1">
                <span
                  class="user-ink block truncate text-sm"
                  style:--user-color={member.avatarColor}>{name}</span
                >
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
