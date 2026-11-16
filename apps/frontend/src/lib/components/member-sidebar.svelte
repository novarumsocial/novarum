<script lang="ts">
  import BotBadge from './bot-badge.svelte';
  import {
    AtSign,
    Ban,
    BellOff,
    Copy,
    IdCardLanyard,
    MessageSquare,
    Phone,
    Shield,
    UserCheck,
    UserMinus,
    UserPlus,
    UserRound,
    Users,
  } from '@lucide/svelte';
  import type { Author } from '$lib/types/chat';
  import Avatar from './avatar.svelte';
  import ProfileCard from './profile-card.svelte';
  import type { Server } from '$lib/types/chat';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { chat } from '$lib/chat-state.svelte';
  import { dms } from '$lib/dms.svelte';
  import { friends } from '$lib/friends.svelte';
  import { isSelf } from '$lib/session.svelte';

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
</script>

{#snippet groupLabel(text: string, count: number, icon = false)}
  <div class="flex items-center gap-1 text-xs font-semibold text-muted-foreground select-none">
    {#if icon}<Users class="size-3.5" />{/if}
    {text} — {count}
  </div>
{/snippet}

{#snippet memberMenu(member: Author)}
  {@const status = friends.statusFor(member.username, member.server)}
  {@const friendshipId = friends.userIdFor(member.username, member.server)}
  <ContextMenu.Content>
    <ContextMenu.Item>
      <UserRound class="size-4" />
      Profile
    </ContextMenu.Item>
    <ContextMenu.Item onclick={() => chat.requestMention(member)}>
      <AtSign class="size-4" />
      Mention
    </ContextMenu.Item>

    {#if !isSelf(member)}
      {#if status === 'FRIEND'}
        <ContextMenu.Item onclick={() => void openDm(member)}>
          <MessageSquare class="size-4" />
          Message
        </ContextMenu.Item>
        <ContextMenu.Item
          onclick={() =>
            void openDm(member).then((channelId) => {
              if (channelId && onCall) onCall(channelId);
            })}
        >
          <Phone class="size-4" />
          Start a Call
        </ContextMenu.Item>
        <ContextMenu.Item onclick={() => friendshipId && void friends.remove(friendshipId)}>
          <UserMinus class="size-4" />
          Remove Friend
        </ContextMenu.Item>
      {:else if status === 'INCOMING'}
        <ContextMenu.Item onclick={() => friendshipId && void friends.accept(friendshipId)}>
          <UserCheck class="size-4" />
          Accept Friend Request
        </ContextMenu.Item>
      {:else if status === 'OUTGOING'}
        <ContextMenu.Item onclick={() => friendshipId && void friends.remove(friendshipId)}>
          <UserMinus class="size-4" />
          Cancel Friend Request
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item
          onclick={() => void friends.request(member.userId, member.username, member.server)}
        >
          <UserPlus class="size-4" />
          Add Friend
        </ContextMenu.Item>
      {/if}
    {/if}

    <ContextMenu.Separator />

    <ContextMenu.Item onclick={() => navigator.clipboard.writeText(member.username)}>
      <Copy class="size-3" />
      Copy Username
    </ContextMenu.Item>
    <ContextMenu.Item
      onclick={() => navigator.clipboard.writeText(member.userId)}
      disabled={!member.userId}
    >
      <IdCardLanyard class="size-3" />
      Copy User ID
    </ContextMenu.Item>

    {#if !isSelf(member)}
      <ContextMenu.Separator />

      <ContextMenu.Item>
        <BellOff class="size-4" />
        Mute
      </ContextMenu.Item>
      <ContextMenu.Item variant="destructive">
        <Ban class="size-4" />
        Block
      </ContextMenu.Item>

      {#if server.canManageChannels}
        <ContextMenu.Separator />

        <ContextMenu.Item>
          <Shield class="size-4" />
          Roles
        </ContextMenu.Item>

        <ContextMenu.Separator />

        <ContextMenu.Item variant="destructive">
          <UserMinus class="size-4" />
          Kick {member.username}
        </ContextMenu.Item>
        <ContextMenu.Item variant="destructive">
          <Ban class="size-4" />
          Ban {member.username}
        </ContextMenu.Item>
      {/if}
    {/if}
  </ContextMenu.Content>
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
                statusBorderClassName="border-background"
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
          {@render memberMenu(member)}
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
            {@render memberMenu(member)}
          </ContextMenu.Root>
        {/each}
      </div>
    {/if}
  </div>
</aside>
