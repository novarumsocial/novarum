<script lang="ts">
  import {
    Volume2,
    Mic,
    MicOff,
    Headphones,
    HeadphoneOff,
    PhoneOff,
    LoaderCircle,
    Video,
    VideoOff,
    MonitorUp,
  } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import type { Author, Channel } from '$lib/types/chat';
  import type { Voice, VoiceVideoTrack } from '$lib/voice.svelte';
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
  const screenShares = $derived(participants.filter(([, state]) => state.screenTrack));
  const tileCount = $derived(participants.length + screenShares.length);
  const gridColumns = $derived(Math.max(1, Math.ceil(Math.sqrt(tileCount))));
  const gridRows = $derived(Math.max(1, Math.ceil(tileCount / gridColumns)));

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
      'bg-rose-600',
      'bg-sky-600',
      'bg-emerald-600',
      'bg-amber-600',
      'bg-purple-600',
      'bg-cyan-600',
      'bg-pink-600',
      'bg-lime-600',
      'bg-indigo-600',
      'bg-teal-600',
      'bg-orange-600',
      'bg-violet-600',
    ];
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  function attachVideo(node: HTMLVideoElement, track: VoiceVideoTrack) {
    track.attach(node);

    return {
      update(nextTrack: VoiceVideoTrack) {
        if (nextTrack === track) return;
        track.detach(node);
        track = nextTrack;
        track.attach(node);
      },
      destroy() {
        track.detach(node);
      },
    };
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
        !voice.connected && !voice.connecting && 'text-muted-foreground'
      )}
    >
      <span
        class={cn(
          'inline-block size-1.5 rounded-none',
          voice.connected && 'bg-emerald-400',
          voice.connecting && 'animate-pulse bg-amber-400',
          !voice.connected && !voice.connecting && 'bg-muted-foreground'
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
        {voice.participantCount}
        {voice.participantCount === 1 ? 'member' : 'members'}
      </span>
    {/if}
  </div>

  <div class="min-h-0 flex-1 px-4 py-4 pb-24">
    {#if voice.connecting}
      <div class="flex size-full flex-col items-center justify-center gap-3 text-center">
        <LoaderCircle class="size-8 animate-spin text-muted-foreground" />
        <p class="text-sm text-muted-foreground">Joining voice channel...</p>
      </div>
    {:else if participants.length === 0}
      <div class="flex size-full flex-col items-center justify-center text-center">
        <p class="text-sm font-medium text-foreground">Connected</p>
        <p class="mt-1 text-sm text-muted-foreground">No one else is here yet.</p>
      </div>
    {:else}
      <div
        class="grid size-full gap-3"
        style="grid-template-columns: repeat({gridColumns}, minmax(0, 1fr)); grid-template-rows: repeat({gridRows}, minmax(0, 1fr));"
      >
        {#each screenShares as [identity, state]}
          {@const name = nameFor(identity)}
          <div
            class="relative min-h-0 overflow-hidden rounded-sm border border-border bg-black shadow-2xl"
          >
            {#if state.screenTrack}
              <video
                class="size-full object-contain"
                autoplay
                playsinline
                muted={identity === voice.localIdentity}
                use:attachVideo={state.screenTrack}
              ></video>
            {/if}
            <div
              class="absolute left-3 top-3 rounded-sm bg-black/70 px-2 py-1 text-xs font-medium text-white backdrop-blur"
            >
              {name} is sharing their screen
            </div>
          </div>
        {/each}

        {#each participants as [identity, state]}
          {@const name = nameFor(identity)}
          <div
            class={cn(
              'relative min-h-0 overflow-hidden rounded-sm border border-border bg-muted transition-shadow duration-150',
              state.speaking && 'ring-2 ring-emerald-400'
            )}
          >
            {#if state.cameraTrack}
              <video
                class="size-full object-cover"
                autoplay
                playsinline
                muted={identity === voice.localIdentity}
                use:attachVideo={state.cameraTrack}
              ></video>
            {:else}
              <div
                class={cn(
                  'flex size-full items-center justify-center text-3xl font-bold text-white',
                  avatarBg(identity)
                )}
              >
                {#if state.selfDeafened}
                  <HeadphoneOff class="size-10" />
                {:else}
                  <div class="flex size-24 items-center justify-center rounded-full bg-black/20">
                    {initialsFor(name)}
                  </div>
                {/if}
              </div>
            {/if}

            <div
              class="absolute bottom-3 left-3 rounded-sm bg-black/65 px-2 py-1 text-sm font-medium text-white backdrop-blur"
            >
              {name}
              {#if identity === voice.localIdentity}
                <span class="text-white/70">(you)</span>
              {/if}
            </div>

            {#if state.selfMuted || state.selfDeafened}
              <div
                class="absolute bottom-3 right-3 flex size-7 items-center justify-center rounded-sm bg-rose-600"
              >
                <MicOff class="size-4 text-white" />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if voice.audioPlaybackBlocked}
      <Button class="absolute bottom-20" onclick={() => voice.startAudio()}>Enable sound</Button>
    {/if}
  </div>

  <!-- control bar -->
  <div
    class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-none border border-border bg-sidebar/80 px-2.5 py-2 shadow-lg backdrop-blur"
  >
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
      variant={voice.selfCamera ? 'default' : 'secondary'}
      size="icon"
      class="size-8"
      onclick={() => voice.setCamera(!voice.selfCamera)}
      aria-label={voice.selfCamera ? 'Turn camera off' : 'Turn camera on'}
    >
      {#if voice.selfCamera}
        <Video class="size-3" />
      {:else}
        <VideoOff class="size-3" />
      {/if}
    </Button>

    <Button
      variant={voice.selfScreenShare ? 'default' : 'secondary'}
      size="icon"
      class="size-8"
      onclick={() => voice.setScreenShare(!voice.selfScreenShare)}
      aria-label={voice.selfScreenShare ? 'Stop sharing screen' : 'Share screen'}
    >
      <MonitorUp class="size-3" />
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
