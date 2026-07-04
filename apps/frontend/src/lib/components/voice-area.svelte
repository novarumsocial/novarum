<script lang="ts">
  import { Volume2, Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, LoaderCircle } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import type { Author, Channel } from '$lib/types/chat';
  import type { Voice } from '$lib/voice.svelte';
  import { ConnectionState } from 'livekit-client';
  import { Button } from '$lib/components/ui/button/index.js';

  let {
    channel,
    voice,
    members,
    onLeave,
  }: {
    channel: Channel;
    voice: Voice;
    members: Author[];
    onLeave: () => void;
  } = $props();

  const participants = $derived(Array.from(voice.voiceStates.entries()));
  const gridCols = $derived(
    participants.length <= 1 ? 'grid-cols-1' :
    participants.length <= 2 ? 'grid-cols-2' :
    'grid-cols-2 lg:grid-cols-3'
  );

  const maxCols = $derived(
    participants.length <= 1 ? 1 :
    participants.length <= 2 ? 2 :
    3
  );

  function initialsFor(id: string) {
    return id
      .split(/[^a-zA-Z0-9]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
      .slice(0, 2);
  }

  function nameFor(identity: string) {
    const member = members.find((item) => item.userId === identity);

    return member?.displayName || member?.username || identity;
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

<div class="relative flex flex-1 flex-col bg-background">
  <!-- header -->
  <div class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
    <Volume2 class="size-5 text-muted-foreground" />
    <span class="text-sm font-semibold text-foreground">{channel.name}</span>
    <span class="mx-1.5 text-muted-foreground/30">|</span>
    <span
      class={cn(
        'inline-flex items-center gap-1.5 text-xs',
        voice.connected && 'text-emerald-400',
        voice.connecting && 'text-amber-400',
        !voice.connected && !voice.connecting && 'text-muted-foreground',
      )}
    >
      <span
        class={cn(
          'inline-block size-1.5 rounded-none',
          voice.connected && 'bg-emerald-400',
          voice.connecting && 'animate-pulse bg-amber-400',
          !voice.connected && !voice.connecting && 'bg-muted-foreground',
        )}
      ></span>
      {#if voice.connecting}
        Connecting...
      {:else if voice.connected}
        Connected
      {:else}
        Disconnected
      {/if}
    </span>
    {#if voice.participantCount > 0}
      <span class="ml-auto text-xs text-muted-foreground">
        {voice.participantCount} {voice.participantCount === 1 ? 'member' : 'members'}
      </span>
    {/if}
  </div>

  <!-- participant grid -->
  <div class="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
    {#if voice.connecting}
      <div class="flex flex-col items-center gap-3 text-center">
        <LoaderCircle class="size-8 animate-spin text-muted-foreground" />
        <p class="text-sm text-muted-foreground">Joining voice channel...</p>
      </div>
    {:else if participants.length === 0}
      <div class="text-center">
        <p class="text-sm font-medium text-foreground">Connected</p>
        <p class="mt-1 text-sm text-muted-foreground">No one else is here yet.</p>
      </div>
    {:else}
      <div
        class="grid w-full max-w-3xl gap-6 {gridCols}"
        style="grid-template-columns: repeat({maxCols}, minmax(0, 1fr))"
      >
        {#each participants as [identity, state]}
          {@const name = nameFor(identity)}
          <div class="flex flex-col items-center gap-3">
            <!-- avatar with speaking ring -->
            <div class="relative">
              <div
                class={cn(
                  'relative flex size-24 items-center justify-center text-2xl font-bold text-white transition-shadow duration-150',
                  avatarBg(identity),
                  state.speaking && 'ring-2 ring-emerald-400',
                )}
              >
                {#if state.selfDeafened}
                  <HeadphoneOff class="size-8" />
                {:else}
                  {initialsFor(name)}
                {/if}
                <!-- mic muted indicator -->
                {#if state.selfMuted}
                  <div class="absolute -bottom-1 -right-1 flex size-7 items-center justify-center bg-rose-600">
                    <MicOff class="size-4 text-white" />
                  </div>
                {:else if state.selfDeafened}
                  <div class="absolute -bottom-1 -right-1 flex size-7 items-center justify-center bg-rose-600">
                    <MicOff class="size-4 text-white" />
                  </div>
                {/if}
              </div>
            </div>
            <!-- name -->
            <span class="text-sm font-medium text-foreground">
              {name}
              {#if identity === voice.localIdentity}
                <span class="text-muted-foreground">(you)</span>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
    {#if voice.audioPlaybackBlocked}
      <Button class="absolute bottom-20" onclick={() => voice.startAudio()}>
        Enable sound
      </Button>
    {/if}
  </div>

  <!-- control bar -->
  <div class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-none border border-border bg-sidebar/80 px-2.5 py-2 shadow-lg backdrop-blur">
    <Button
      variant={voice.selfMuted ? 'destructive' : 'secondary'}
      size="icon"
      class="size-8"
      onclick={() => voice.setMuted(!voice.selfMuted)}
      disabled={voice.selfDeafened}
      aria-label={voice.selfMuted ? 'Unmute' : 'Mute'}
    >
      {#if voice.selfMuted}
        <MicOff class="size-3" />
      {:else}
        <Mic class="size-3" />
      {/if}
    </Button>

    <Button
      variant={voice.selfDeafened ? 'destructive' : 'secondary'}
      size="icon"
      class="size-8"
      onclick={() => voice.setDeafened(!voice.selfDeafened)}
      aria-label={voice.selfDeafened ? 'Undeafen' : 'Deafen'}
    >
      {#if voice.selfDeafened}
        <HeadphoneOff class="size-3" />
      {:else}
        <Headphones class="size-3" />
      {/if}
    </Button>

    <Button
      variant="destructive"
      size="icon"
      class="size-8"
      onclick={onLeave}
      aria-label="Leave call"
    >
      <PhoneOff class="size-3" />
    </Button>
  </div>
</div>
