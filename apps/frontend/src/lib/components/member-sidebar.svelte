<script lang="ts">
  import { Volume2, Users, Mic, MicOff } from "@lucide/svelte";
  import type { Author, VoiceUser } from "$lib/types/chat";
  import type { Voice } from "$lib/voice.svelte";
  import { cn } from "$lib/utils";

  let {
    members,
    voiceUsers,
    voice,
  }: {
    members: Author[];
    voiceUsers: VoiceUser[];
    voice?: Voice | null;
  } = $props();

  const online = $derived(members.filter((member) => member.status !== 'OFFLINE'));
  const offline = $derived(members.filter((member) => member.status === 'OFFLINE'));

  // real-time voice participants from LiveKit
  const liveParticipants = $derived(voice?.voiceStates ? Array.from(voice.voiceStates.entries()) : []);

  function initialsFor(id: string) {
    return id
      .split(/[^a-zA-Z0-9]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
      .slice(0, 2);
  }

  function avatarBg(id: string) {
    const colors = [
      'bg-rose-600', 'bg-sky-600', 'bg-emerald-600', 'bg-amber-600',
      'bg-purple-600', 'bg-cyan-600', 'bg-pink-600', 'bg-lime-600',
      'bg-indigo-600', 'bg-teal-600', 'bg-orange-600', 'bg-violet-600',
    ];
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }
</script>

<aside class="flex w-56 flex-col bg-sidebar">
  <div class="h-12 shrink-0 border-b border-border"></div>

  <div class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
    <!-- livekit voice participants -->
    {#if liveParticipants.length > 0}
      <div class="mb-3 rounded-none border border-primary/15 bg-primary/[0.03] p-2">
        <div class="mb-2 flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Volume2 class="size-3.5" />
          Voice Connected
        </div>
        <div class="space-y-1">
          {#each liveParticipants as [identity, state]}
            <div class="flex items-center gap-2 px-1 py-1">
              <div class="relative flex size-7 shrink-0 items-center justify-center text-xs font-bold text-white {avatarBg(identity)}">
                {state.selfDeafened ? '!' : initialsFor(identity)}
                {#if state.speaking}
                  <span class="absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center">
                    <span class="absolute inset-0 animate-ping rounded-none bg-emerald-400/40"></span>
                    <span class="relative size-1.5 rounded-none bg-emerald-400"></span>
                  </span>
                {/if}
              </div>
              <span class="min-w-0 flex-1 truncate text-sm text-foreground">
                {identity}
                {#if identity === voice?.localIdentity}
                  <span class="text-[10px] text-muted-foreground">(you)</span>
                {/if}
              </span>
              <button
                class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={state.selfMuted ? "Unmute" : "Mute"}
              >
                {#if state.selfMuted || state.selfDeafened}
                  <MicOff class="size-3.5 text-rose-400" />
                {:else}
                  <Mic class="size-3.5" />
                {/if}
              </button>
            </div>
          {/each}
        </div>
      </div>
    {:else if voiceUsers.length > 0}
      <!-- fallback: static voice users from chat state -->
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
