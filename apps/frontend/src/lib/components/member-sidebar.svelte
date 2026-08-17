<script lang="ts">
  import { Users } from '@lucide/svelte';
  import type { Author } from '$lib/types/chat';
  import Avatar from './avatar.svelte';
  import ProfileCard from './profile-card.svelte';
  import { settings } from '$lib/settings.svelte';
  import { Input } from '$lib/components/ui/input/index.js';
  import type { Server } from '$lib/types/chat';
  import { useSession } from '$lib/session.svelte';

  let {
    server,
    members,
  }: {
    server: Server;
    members: Author[];
  } = $props();

  const online = $derived(members.filter((member) => member.status !== 'OFFLINE'));
  const offline = $derived(members.filter((member) => member.status === 'OFFLINE'));
  const isSelf = $derived(
    (member: Author) =>
      Boolean(useSession().user) &&
      member.username === useSession().user?.username &&
      member.server === useSession().user?.homeserver
  );

  function nameFor(member: Author) {
    return member.displayName || member.username;
  }
</script>

{#if settings.value.showMemberList}
  <aside class="flex size-full w-56 flex-col bg-sidebar">
    <div class="h-12 shrink-0 border-b border-border p-2">
      <!--
      <Input
        id="search-in-channel"
        placeholder="Search {server.name}"
        autocomplete="off"
        spellcheck="false"
      />
-->
    </div>
    <div class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
      <div class="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
        <Users class="size-3.5" />
        Online - {online.length}
      </div>
      <div class="space-y-0.5">
        {#each online as member}
          {@const name = nameFor(member)}
          <ProfileCard user={member} class="group flex w-full items-center gap-2 px-1 py-1">
            <div class="relative">
              <Avatar
                src={member.avatarUrl}
                {name}
                class="size-7 text-xs"
                bgColor={member.avatarColor}
              />
              <span
                class="absolute -bottom-px -right-px size-2.5 border-2 border-sidebar bg-emerald-500"
              ></span>
              {#if settings.value.circleIcons}
                <span
                  class="rounded-full absolute -bottom-px -right-px size-2.75 border-2 border-sidebar bg-emerald-500"
                ></span>
              {/if}
              <!-- TODO: fix dependency for user.status -->
            </div>
            <div class="flex min-w-0 flex-1">
              <span class="block truncate text-sm text-foreground">{name}</span>
              <span
                class="block truncate text-[10px] text-muted-foreground ml-1 mt-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              >
                ({member.server})
              </span>
              <!--old
              <span class="block truncate text-[10px] text-muted-foreground">
                @{member.username}:{member.server}
              </span>
              -->
            </div>
          </ProfileCard>
        {/each}
      </div>

      {#if offline.length > 0}
        <div class="mt-4 text-xs font-semibold text-muted-foreground">
          Offline - {offline.length}
        </div>
        <div class="space-y-0.5 opacity-50">
          {#each offline as member}
            {@const name = nameFor(member)}
            <ProfileCard user={member} class="group flex w-full items-center gap-2 px-1 py-1">
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
                  class="block truncate text-[10px] text-muted-foreground ml-1 mt-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ({member.server})
                </span>
              </div>
              <!-- TODO: when hide online status is available => highlight user's profile with grey offline status circle -->
            </ProfileCard>
          {/each}
        </div>
      {/if}
    </div>
  </aside>
{/if}
