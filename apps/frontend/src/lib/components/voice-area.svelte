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
    Maximize2,
    Minimize2,
    TriangleAlert,
  } from '@lucide/svelte';
  import { ConnectionState } from 'livekit-client';
  import { cn } from '$lib/utils';
  import type { Author, Channel } from '$lib/types/chat';
  import type { Voice } from '$lib/voice.svelte';
  import { type VoiceTile } from '$lib/voice-layout';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import { settings } from '$lib/settings.svelte';
  import VoiceStage from './voice-stage.svelte';

  let {
    channel,
    voice,
    members,
    onJoin,
    onLeave,
    onOpenNavigation,
    onOpenMembers,
    embedded = false,
    expanded = false,
    onToggleExpand,
  }: {
    channel: Channel;
    voice: Voice;
    members: Author[];
    onJoin: () => void;
    onLeave: () => void;
    onOpenNavigation?: () => void;
    onOpenMembers?: () => void;
    embedded?: boolean;
    expanded?: boolean;
    onToggleExpand?: () => void;
  } = $props();

  const active = $derived(voice.channelId === channel.id && (voice.connected || voice.connecting));
  const reconnecting = $derived(
    voice.channelId === channel.id &&
      (voice.connectionState === ConnectionState.Reconnecting ||
        voice.connectionState === ConnectionState.SignalReconnecting)
  );

  const memberById = $derived(new Map(members.map((member) => [member.userId, member])));

  function nameFor(identity: string) {
    const member = memberById.get(identity);
    return member?.displayName || member?.username || identity;
  }

  const tiles = $derived.by<VoiceTile[]>(() => {
    const entries = Array.from(voice.voiceStates.entries());
    const build = (kind: 'screen' | 'participant') =>
      entries
        .filter(([, state]) => (kind === 'screen' ? state.screenTrack : true))
        .map(([identity, state]) => ({
          key: kind === 'screen' ? `screen:${identity}` : identity,
          identity,
          state,
          kind,
          member: memberById.get(identity),
          name: nameFor(identity),
        }));

    // Screen shares first so they sort ahead of the people sharing them.
    return [...build('screen'), ...build('participant')];
  });

  // The tile someone explicitly clicked into the spotlight. Beats screen-share
  // auto-promotion, same as clicking a face over a presentation in a real call.
  let focusedKey = $state<string | null>(null);
  let manualGrid = $state(false);
  let fullscreen = $state(false);
  let stageElement = $state<HTMLElement | null>(null);

  const autoSpotlightKey = $derived(tiles.find((tile) => tile.kind === 'screen')?.key ?? null);

  const spotlightKey = $derived.by(() => {
    if (focusedKey && tiles.some((tile) => tile.key === focusedKey)) return focusedKey;
    return manualGrid ? null : autoSpotlightKey;
  });

  // Discord-style stream volume: only shown while spotlit on someone else's
  // screen share, and only affects that share's audio, not their mic.
  const spotlightScreenShare = $derived(
    tiles.find(
      (tile) =>
        tile.key === spotlightKey && tile.kind === 'screen' && tile.identity !== voice.localIdentity
    ) ?? null
  );

  // A newly started screen share takes over the stage, even if the user had chosen grid.
  let lastAutoKey: string | null = null;
  $effect(() => {
    const key = autoSpotlightKey;
    if (key && key !== lastAutoKey) manualGrid = false;
    lastAutoKey = key;
  });

  // If the person you focused on leaves, fall back instead of silently re-focusing
  // whoever reuses that identity next.
  $effect(() => {
    if (focusedKey && !tiles.some((tile) => tile.key === focusedKey)) focusedKey = null;
  });

  // Clicking a tile in the grid or filmstrip spotlights it — a person with or
  // without a camera, or a screen share all work the same way.
  function focusTile(key: string) {
    focusedKey = key;
    manualGrid = false;
  }

  function showGrid() {
    focusedKey = null;
    manualGrid = true;
  }

  const controlClass = $derived(cn('size-10', settings.value.circleIcons && 'rounded-full'));
  const micLabel = $derived(voice.selfDeafened ? 'Undeafen' : voice.selfMuted ? 'Unmute' : 'Mute');
  const cameraLabel = $derived(voice.selfCamera ? 'Turn camera off' : 'Turn camera on');
  const screenLabel = $derived(voice.selfScreenShare ? 'Stop sharing screen' : 'Share screen');

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    await stageElement?.requestFullscreen().catch(() => undefined);
  }
</script>

<svelte:document onfullscreenchange={() => (fullscreen = !!document.fullscreenElement)} />

<div class="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
  {#if !embedded}
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
      <Volume2 class="size-5 shrink-0 text-muted-foreground" />
      <span class="truncate text-sm font-semibold text-foreground">{channel.name}</span>
      {#if active && !voice.connecting}
        <span class="shrink-0 text-xs text-muted-foreground">
          {voice.participantCount}
        </span>
      {/if}

      <div class="ml-auto flex items-center gap-1">
        {#if active}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="ghost"
                  size="icon-lg"
                  onclick={toggleFullscreen}
                  aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                >
                  {#if fullscreen}
                    <Minimize2 class="size-4" />
                  {:else}
                    <Maximize2 class="size-4" />
                  {/if}
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</Tooltip.Content>
          </Tooltip.Root>
        {/if}

        <Button
          variant="ghost"
          size="icon-lg"
          class="lg:hidden"
          onclick={onOpenMembers}
          aria-label="Open members"
        >
          <Users class="size-5" />
        </Button>
      </div>
    </div>
  {/if}

  <div
    bind:this={stageElement}
    class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
  >
    {#if fullscreen}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="secondary"
              size="icon-lg"
              class="absolute right-2 top-2 z-20 shadow-md"
              onclick={toggleFullscreen}
              aria-label="Exit fullscreen"
            >
              <Minimize2 class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Exit fullscreen</Tooltip.Content>
      </Tooltip.Root>
    {/if}

    {#if reconnecting}
      <div
        class="flex shrink-0 items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-2 text-xs text-amber-400"
        role="status"
      >
        <LoaderCircle class="size-3.5 animate-spin" />
        Reconnecting to voice...
      </div>
    {/if}

    {#if active && voice.audioPlaybackBlocked}
      <div
        class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-2 text-xs text-amber-400"
      >
        <TriangleAlert class="size-3.5 shrink-0" />
        <span class="min-w-0 flex-1">Your browser blocked audio playback.</span>
        <Button variant="secondary" size="xs" onclick={() => voice.startAudio()}>
          Enable sound
        </Button>
      </div>
    {/if}

    {#if !active}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
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
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
        <LoaderCircle class="size-8 animate-spin text-muted-foreground" />
        <p class="text-sm text-muted-foreground">Joining voice channel...</p>
      </div>
    {:else if tiles.length === 0}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
        <p class="text-sm font-medium text-foreground">Connected</p>
        <p class="mt-1 text-sm text-muted-foreground">No one else is here yet.</p>
      </div>
    {:else}
      <VoiceStage {tiles} {voice} {spotlightKey} onFocus={focusTile} onExitSpotlight={showGrid} />
    {/if}

    {#if active}
      <div
        class="relative flex shrink-0 items-center justify-center gap-1.5 border-t border-border bg-sidebar/60 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:gap-2"
      >
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant={voice.selfMuted ? 'destructive' : 'secondary'}
                size="icon"
                class={controlClass}
                aria-label={micLabel}
                aria-pressed={voice.selfMuted}
                onclick={() =>
                  voice.selfDeafened ? voice.setDeafened(false) : voice.setMuted(!voice.selfMuted)}
              >
                {#if voice.selfMuted}
                  <MicOff class="size-4" />
                {:else}
                  <Mic class="size-4" />
                {/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>{micLabel}</Tooltip.Content>
        </Tooltip.Root>

        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant={voice.selfDeafened ? 'destructive' : 'secondary'}
                size="icon"
                class={controlClass}
                aria-label={voice.selfDeafened ? 'Undeafen' : 'Deafen'}
                aria-pressed={voice.selfDeafened}
                onclick={() => voice.setDeafened(!voice.selfDeafened)}
              >
                {#if voice.selfDeafened}
                  <HeadphoneOff class="size-4" />
                {:else}
                  <Headphones class="size-4" />
                {/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>{voice.selfDeafened ? 'Undeafen' : 'Deafen'}</Tooltip.Content>
        </Tooltip.Root>

        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant={voice.selfCamera ? 'default' : 'secondary'}
                size="icon"
                class={controlClass}
                aria-label={cameraLabel}
                aria-pressed={voice.selfCamera}
                onclick={() => voice.setCamera(!voice.selfCamera)}
              >
                {#if voice.selfCamera}
                  <Video class="size-4" />
                {:else}
                  <VideoOff class="size-4" />
                {/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>{cameraLabel}</Tooltip.Content>
        </Tooltip.Root>

        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant={voice.selfScreenShare ? 'default' : 'secondary'}
                size="icon"
                class={controlClass}
                aria-label={screenLabel}
                aria-pressed={voice.selfScreenShare}
                onclick={() => voice.setScreenShare(!voice.selfScreenShare)}
              >
                <MonitorUp class="size-4" />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>{screenLabel}</Tooltip.Content>
        </Tooltip.Root>

        {#if spotlightScreenShare}
          {@const identity = spotlightScreenShare.identity}
          <Popover.Root>
            <Popover.Trigger
              class={cn(
                controlClass,
                'inline-flex items-center justify-center rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80'
              )}
              aria-label={`Stream volume for ${spotlightScreenShare.name}`}
              title="Stream volume"
            >
              <Volume2 class="size-4" />
            </Popover.Trigger>
            <Popover.Content side="top" align="center" class="w-48 flex-col items-start gap-2">
              <p class="flex w-full justify-between text-sm">
                <span>Stream volume</span>
                <span>{Math.round(voice.participantScreenVolume(identity) * 100)}%</span>
              </p>
              <Slider
                type="single"
                aria-label={`Stream volume for ${spotlightScreenShare.name}`}
                min={0}
                max={300}
                step={1}
                value={voice.participantScreenVolume(identity) * 100}
                onValueChange={(volume) => voice.setParticipantScreenVolume(identity, volume / 100)}
                onThumbDblClick={() => voice.setParticipantScreenVolume(identity, 1)}
              />
            </Popover.Content>
          </Popover.Root>
        {/if}

        <div class="mx-1 h-6 w-px shrink-0 bg-border"></div>

        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                size="icon"
                class={cn(controlClass, 'bg-destructive text-white hover:bg-destructive/90')}
                aria-label="Leave call"
                onclick={onLeave}
              >
                <PhoneOff class="size-4" />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Leave call</Tooltip.Content>
        </Tooltip.Root>

        {#if onToggleExpand}
          <Button
            variant="ghost"
            size="icon"
            class={cn(controlClass, 'absolute right-2 text-muted-foreground hover:text-foreground')}
            onclick={onToggleExpand}
            aria-label={expanded ? 'Show messages' : 'Expand call'}
          >
            {#if expanded}
              <Minimize2 class="size-4" />
            {:else}
              <Maximize2 class="size-4" />
            {/if}
          </Button>
        {/if}
      </div>
    {/if}
  </div>
</div>
