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
    Menu,
    Users,
  } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import type { Author, Channel } from '$lib/types/chat';
  import type { Voice, VoiceVideoTrack } from '$lib/voice.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import Avatar from './avatar.svelte';
  import ParticipantContextMenu from './participant-context-menu.svelte';
  import { settings } from '$lib/settings.svelte';

  let {
    channel,
    voice,
    members,
    onJoin,
    onLeave,
    onOpenNavigation,
    onOpenMembers,
  }: {
    channel: Channel;
    voice: Voice;
    members: Author[];
    onJoin: () => void;
    onLeave: () => void;
    onOpenNavigation?: () => void;
    onOpenMembers?: () => void;
  } = $props();

  const participants = $derived(Array.from(voice.voiceStates.entries()));
  const active = $derived(voice.channelId === channel.id && (voice.connected || voice.connecting));
  const screenShares = $derived(participants.filter(([, state]) => state.screenTrack));
  const tiles = $derived([
    ...screenShares.map(([identity, state]) => ({
      key: `screen:${identity}`,
      identity,
      state,
      kind: 'screen' as const,
    })),
    ...participants.map(([identity, state]) => ({
      key: identity,
      identity,
      state,
      kind: 'participant' as const,
    })),
  ]);
  const tileCount = $derived(tiles.length);
  const gridColumns = $derived(Math.max(1, Math.ceil(Math.sqrt(tileCount))));
  const gridRows = $derived(Math.max(1, Math.ceil(tileCount / gridColumns)));

  let focused = $state<string | null>(null);
  const focusTile = $derived(tiles.find((t) => t.key === focused) ?? null);

  function toggleFocus(key: string) {
    focused = focused === key ? null : key;
  }

  function initialsFor(id: string) {
    return id
      .split(/[^a-zA-Z0-9]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
      .slice(0, 2);
  }

  function memberFor(identity: string) {
    return members.find((item) => item.userId === identity);
  }

  function nameFor(identity: string) {
    const member = memberFor(identity);
    return member?.displayName || member?.username || identity;
  }

  function fallbackAvatarBg(id: string) {
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
  <div class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-4">
    <Button
      variant="ghost"
      size="icon-lg"
      class="md:hidden"
      onclick={onOpenNavigation}
      aria-label="Open channels"
    >
      <Menu class="size-5" />
    </Button>
    <Volume2 class="size-5 text-muted-foreground" />
    <span class="text-sm font-semibold text-foreground">{channel.name}</span>
    <Button
      variant="ghost"
      size="icon-lg"
      class="ml-auto lg:hidden"
      onclick={onOpenMembers}
      aria-label="Open members"
    >
      <Users class="size-5" />
    </Button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-2 py-3 pb-24 sm:px-4 sm:py-4">
    {#if !active}
      <div class="flex size-full flex-col items-center justify-center gap-4 text-center">
        <div>
          <p class="text-sm font-medium text-foreground">Join {channel.name}</p>
          <p class="mt-1 text-sm text-muted-foreground">Connect when you are ready.</p>
        </div>
        <Button onclick={onJoin}>
          <Volume2 class="size-4" />
          Join Voice
        </Button>
      </div>
    {:else if voice.connecting}
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
      {#snippet tile(t: (typeof tiles)[number])}
        {@const name = nameFor(t.identity)}
        {@const member = memberFor(t.identity)}
        {#if t.kind === 'screen'}
          <div
            class="min-h-0 min-w-0 cursor-pointer w-full"
            role="button"
            tabindex="0"
            onclick={() => toggleFocus(t.key)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleFocus(t.key)}
          >
            <div
              class="relative aspect-video max-h-full w-full overflow-hidden rounded-sm border border-border bg-black"
            >
              {#if t.state.screenTrack}
                <video
                  class="size-full object-cover"
                  autoplay
                  playsinline
                  muted={t.identity === voice.localIdentity}
                  use:attachVideo={t.state.screenTrack}
                ></video>
              {/if}
              <div
                class="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-sm bg-black/65 px-2 py-1 text-sm font-medium text-white backdrop-blur"
              >
                <MonitorUp class="size-4" />
                <span>{name}</span>
                {#if t.identity === voice.localIdentity}
                  <span class="text-white/70">(you)</span>
                {/if}
              </div>
            </div>
          </div>
        {:else}
          <ParticipantContextMenu {voice} identity={t.identity} {name}>
            <div
              class={cn(
                'min-h-0 min-w-0 cursor-pointer',
                t.state.speaking && 'ring'
              )}
              style:--tw-ring-color={member?.speakingRingColor ?? '#00d492'}
              role="button"
              tabindex="0"
              onclick={() => toggleFocus(t.key)}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleFocus(t.key)}
            >
              <div
                class="relative aspect-video max-h-full w-full overflow-hidden rounded-sm border border-border bg-muted transition-shadow duration-150"
              >
                {#if t.state.cameraTrack}
                  <video
                    class="size-full object-cover"
                    autoplay
                    playsinline
                    muted={t.identity === voice.localIdentity}
                    use:attachVideo={t.state.cameraTrack}
                  ></video>
                {:else}
                  <div
                    class={cn(
                      'relative flex size-full items-center justify-center overflow-hidden',
                      !member?.avatarColor && fallbackAvatarBg(t.identity)
                    )}
                    style:background-color={member?.avatarColor}
                  >
                    <Avatar
                      src={member?.avatarUrl}
                      {name}
                      fallback={initialsFor(name)}
                      class="relative size-20 rounded-full border-2 border-white/30 bg-black/20 text-2xl text-white shadow-2xl ring-4 ring-black/10 sm:size-28 sm:text-3xl"
                      bgColor={member?.avatarColor}
                    />
                  </div>
                {/if}

                <div
                  class="absolute bottom-3 left-3 rounded-sm bg-black/65 px-2 py-1 text-sm font-medium text-white backdrop-blur"
                >
                  {name}
                  {#if t.identity === voice.localIdentity}
                    <span class="text-white/70">(you)</span>
                  {/if}
                </div>

                {#if t.state.selfMuted || t.state.selfDeafened}
                  <div
                    class="absolute bottom-3 right-3 flex size-7 items-center justify-center bg-rose-600"
                    class:rounded-full={settings.value.circleIcons}
                  >
                    {#if t.state.selfMuted && !t.state.selfDeafened}
                      <MicOff class="size-4 text-white" />
                    {:else if t.state.selfDeafened}
                      <HeadphoneOff class="size-4 text-white" />
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          </ParticipantContextMenu>
        {/if}
      {/snippet}

      {#if focusTile}
        <div class="flex size-full flex-col gap-3 sm:flex-row">
          <div
            class="min-h-0 flex-1 cursor-pointer p-1"
            role="button"
            tabindex="0"
            onclick={() => toggleFocus(focusTile.key)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleFocus(focusTile.key)}
          >
            {@render tile(focusTile)}
          </div>
          <div class="flex shrink-0 gap-3 sm:w-44 sm:flex-col sm:overflow-y-auto">
            {#each tiles.filter((t) => t.key !== focused) as t}
              {@render tile(t)}
            {/each}
          </div>
        </div>
      {:else}
        <div
          class="participant-grid grid min-h-full gap-3 sm:size-full"
          style={`--grid-columns: ${gridColumns}; --grid-rows: ${gridRows};`}
        >
          {#each tiles as t}
            {@render tile(t)}
          {/each}
        </div>
      {/if}
    {/if}
    {#if active && voice.audioPlaybackBlocked}
      <Button class="absolute bottom-20" onclick={() => voice.startAudio()}>Enable sound</Button>
    {/if}
  </div>

  <!-- control bar -->
  {#if active}
    <div
      class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 border border-border bg-sidebar/80 px-2 py-2 shadow-lg backdrop-blur sm:bottom-4 sm:gap-2 sm:px-2.5"
      class:rounded-full={settings.value.circleIcons}
    >
      <Button
        variant={voice.selfMuted ? 'destructive' : 'secondary'}
        size="icon"
        class="size-10 sm:size-8 {settings.value.circleIcons ? 'rounded-full' : ''}"
        onclick={() =>
          voice.selfDeafened ? voice.setDeafened(false) : voice.setMuted(!voice.selfMuted)}
        aria-label={voice.selfDeafened ? 'Undeafen' : voice.selfMuted ? 'Unmute' : 'Mute'}
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
        class="size-10 sm:size-8 {settings.value.circleIcons ? 'rounded-full' : ''}"
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
        class="size-10 sm:size-8 {settings.value.circleIcons ? 'rounded-full' : ''}"
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
        class="size-10 sm:size-8 {settings.value.circleIcons ? 'rounded-full' : ''}"
        onclick={() => voice.setScreenShare(!voice.selfScreenShare)}
        aria-label={voice.selfScreenShare ? 'Stop sharing screen' : 'Share screen'}
      >
        <MonitorUp class="size-3" />
      </Button>

      <Button
        variant="destructive"
        size="icon"
        class="size-10 sm:size-8 {settings.value.circleIcons ? 'rounded-full' : ''}"
        onclick={onLeave}
        aria-label="Leave call"
      >
        <PhoneOff class="size-3" />
      </Button>
    </div>
  {/if}
</div>

<style>
  .participant-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-auto-rows: minmax(180px, 1fr);
  }

  @media (min-width: 640px) {
    .participant-grid {
      grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
      grid-template-rows: repeat(var(--grid-rows), minmax(0, 1fr));
    }
  }
</style>
