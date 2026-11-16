<script lang="ts">
  import { goto } from '$app/navigation';
  import { Crown, LogOut, Settings, UserPlus, Users } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { dms, type DmEntry } from '$lib/dms.svelte';
  import { friends } from '$lib/friends.svelte';
  import { useSession } from '$lib/session.svelte';
  import type { Author } from '$lib/types/chat';
  import Avatar from './avatar.svelte';
  import BotBadge from './bot-badge.svelte';
  import ProfileCard from './profile-card.svelte';
  import NewDmDialog from './new-dm-dialog.svelte';
  import GroupSettingsDialog from './group-settings-dialog.svelte';

  let { group, onCall }: { group: DmEntry; onCall?: (channelId: string) => void } = $props();

  const me = $derived(useSession().user);
  const isOwner = $derived(!!me && group.ownerId === me.id);
  const members = $derived<Author[]>([
    ...(me ? [{ ...me, userId: me.id, server: me.homeserver }] : []),
    ...group.participants.map(({ homeserver, ...user }) => ({ ...user, server: homeserver })),
  ] as Author[]);

  let addOpen = $state(false);
  let settingsOpen = $state(false);
  let error = $state<string | null>(null);

  async function act(action: Promise<string | null>) {
    error = await action;
  }

  async function leave() {
    error = await dms.leave(group.id);
    if (!error) void goto('/guilds/dms');
  }
</script>

<aside class="flex size-full w-56 flex-col bg-sidebar">
  <div class="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
    <Button variant="ghost" size="icon" aria-label="Add people" onclick={() => (addOpen = true)}>
      <UserPlus class="size-4" />
    </Button>
    {#if isOwner}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Group settings"
        onclick={() => (settingsOpen = true)}
      >
        <Settings class="size-4" />
      </Button>
    {/if}
    <span class="flex-1"></span>
    <Button variant="ghost" size="icon" aria-label="Leave group" title="Leave group" onclick={leave}>
      <LogOut class="size-4" />
    </Button>
  </div>
  <div class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
    <div class="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
      <Users class="size-3.5" />
      Members - {members.length}
    </div>
    {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
    <div class="space-y-0.5">
      {#each members as member (member.userId)}
        {@const name = member.displayName || member.username}
        {@const self = member.userId === me?.id}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            <ProfileCard user={member} {onCall} class="group flex w-full items-center gap-2 px-1 py-1">
              <div class="relative">
                <Avatar
                  src={member.avatarUrl}
                  {name}
                  class="size-7 text-xs"
                  bgColor={member.avatarColor}
                />
                {#if self || friends.isOnline(member.userId)}
                  <span
                    class="absolute -right-px -bottom-px size-2.5 border-2 border-sidebar bg-emerald-500"
                  ></span>
                {/if}
              </div>
              <div class="flex min-w-0 flex-1 items-center">
                <span class="block truncate text-sm text-foreground">{name}</span>
                {#if member.isBot}<BotBadge class="ml-1.5 shrink-0" />{/if}
                {#if member.userId === group.ownerId}
                  <Crown class="ml-1.5 size-3.5 shrink-0 text-amber-500" aria-label="Group owner" />
                {/if}
              </div>
            </ProfileCard>
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            <ContextMenu.Item onclick={() => navigator.clipboard.writeText(member.userId)}>
              Copy User ID
            </ContextMenu.Item>
            {#if isOwner && !self}
              <ContextMenu.Separator />
              {#if !member.isBot}
                <ContextMenu.Item onclick={() => act(dms.transferOwner(group.id, member.userId))}>
                  Make Group Owner
                </ContextMenu.Item>
              {/if}
              <ContextMenu.Item
                variant="destructive"
                onclick={() => act(dms.kick(group.id, member.userId))}
              >
                Remove from Group
              </ContextMenu.Item>
            {/if}
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    </div>
  </div>
</aside>

<NewDmDialog bind:open={addOpen} addTo={group} />
{#if isOwner}
  <GroupSettingsDialog bind:open={settingsOpen} {group} />
{/if}
