<script lang="ts">
  import { Globe, Volume2, Users, Mic, MicOff } from "@lucide/svelte";
  import type { Author, VoiceUser } from "$lib/data/mock";

  let {
    members,
    voiceUsers,
  }: {
    members: Author[];
    voiceUsers: VoiceUser[];
  } = $props();

  const online = $derived(members);
  const offline: Author[] = [];
</script>

<aside class="flex w-56 flex-col bg-sidebar">
  <div class="h-12 shrink-0 border-b border-border"></div>

  <div class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
    {#if voiceUsers.length > 0}
      <div class="mb-3 rounded-none border border-primary/15 bg-primary/[0.03] p-2">
        <div class="mb-2 flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Volume2 class="size-3.5" />
          Voice Connected
        </div>
        <div class="space-y-1">
          {#each voiceUsers as vu}
            <div class="flex items-center gap-2 px-1 py-1">
              <div class="relative flex size-7 shrink-0 items-center justify-center text-xs font-bold text-white {vu.avatarColor}">
                {vu.username.charAt(0).toUpperCase()}
                {#if vu.speaking}
                  <span class="absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center">
                    <span class="absolute inset-0 animate-ping rounded-none bg-emerald-400/40"></span>
                    <span class="relative size-1.5 rounded-none bg-emerald-400"></span>
                  </span>
                {/if}
              </div>
              <span class="min-w-0 flex-1 truncate text-sm text-foreground">{vu.username}</span>
              <button class="shrink-0 text-muted-foreground transition-colors hover:text-foreground" aria-label={vu.muted ? "Unmute" : "Mute"}>
                {#if vu.muted}
                  <MicOff class="size-3.5 text-rose-400" />
                {:else}
                  <Mic class="size-3.5" />
                {/if}
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
      <Users class="size-3.5" />
      Online - {online.length}
    </div>
    <div class="space-y-0.5">
      {#each online as member}
        <div class="flex items-center gap-2 px-1 py-1">
          <div class="relative flex size-7 shrink-0 items-center justify-center text-xs font-bold text-white {member.avatarColor}">
            {member.displayName.charAt(0).toUpperCase()}
            <span class="absolute -bottom-px -right-px size-2.5 rounded-none border-2 border-sidebar bg-emerald-500"></span>
          </div>
          <div class="min-w-0 flex-1">
            <span class="block truncate text-sm text-foreground">{member.displayName}</span>
            <span class="block truncate text-[10px] text-muted-foreground">
              @{member.username}@{member.server}
            </span>
          </div>
          {#if member.server !== "novarum.social"}
            <Globe class="size-3 shrink-0 text-primary/50" title={member.server} />
          {/if}
        </div>
      {/each}
    </div>

    {#if offline.length > 0}
      <div class="mt-4 text-xs font-semibold text-muted-foreground">Offline - {offline.length}</div>
      <div class="space-y-0.5 opacity-50">
        {#each offline as member}
          <div class="flex items-center gap-2 px-1 py-1">
            <div class="flex size-7 items-center justify-center text-xs font-bold text-white {member.avatarColor}">
              {member.displayName.charAt(0).toUpperCase()}
            </div>
            <span class="text-sm text-foreground">{member.displayName}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</aside>

