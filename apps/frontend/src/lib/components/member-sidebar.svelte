<script lang="ts">
  import { Users } from '@lucide/svelte';
  import type { Author } from '$lib/types/chat';
  import Avatar from './avatar.svelte';

  let {
    members,
  }: {
    members: Author[];
  } = $props();

  const online = $derived(members.filter((member) => member.status !== 'OFFLINE'));
  const offline = $derived(members.filter((member) => member.status === 'OFFLINE'));

  function nameFor(member: Author) {
    return member.displayName || member.username;
  }
</script>

<aside class="flex w-56 flex-col bg-sidebar">
  <div class="h-12 shrink-0 border-b border-border"></div>

  <div class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
    <div class="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
      <Users class="size-3.5" />
      Online - {online.length}
    </div>
    <div class="space-y-0.5">
      {#each online as member}
        {@const name = nameFor(member)}
        <div class="flex items-center gap-2 px-1 py-1">
          <div class="relative">
            <Avatar src={member.avatarUrl} {name} class="size-7 text-xs" />
            <span
              class="absolute -bottom-px -right-px size-2.5 rounded-none border-2 border-sidebar bg-emerald-500"
            ></span>
          </div>
          <div class="min-w-0 flex-1">
            <span class="block truncate text-sm text-foreground">{name}</span>
            <span class="block truncate text-[10px] text-muted-foreground">
              <!-- TODO: show member server on hover -->
              @{member.username}@{member.server}
            </span>
          </div>
        </div>
      {/each}
    </div>

    {#if offline.length > 0}
      <div class="mt-4 text-xs font-semibold text-muted-foreground">Offline - {offline.length}</div>
      <div class="space-y-0.5 opacity-50">
        {#each offline as member}
          {@const name = nameFor(member)}
          <div class="flex items-center gap-2 px-1 py-1">
            <Avatar src={member.avatarUrl} {name} class="size-7 text-xs" />
            <span class="text-sm text-foreground">{name}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</aside>
