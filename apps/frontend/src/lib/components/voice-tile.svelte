<script lang="ts">
  import { MicOff, HeadphoneOff, MonitorUp } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import { settings } from '$lib/settings.svelte';
  import type { Voice, VoiceVideoTrack } from '$lib/voice.svelte';
  import { fallbackAvatarBg, initialsFor, type VoiceTile } from '$lib/voice-layout';
  import Avatar from './avatar.svelte';
  import ParticipantContextMenu from './participant-context-menu.svelte';

  let {
    tile,
    voice,
    width,
    height,
    compact = false,
    onSelect,
    ariaLabel,
  }: {
    tile: VoiceTile;
    voice: Voice;
    width?: number;
    height?: number;
    compact?: boolean;
    // Passed for a clickable tile: grid/filmstrip tiles spotlight on click, the
    // spotlighted tile itself exits back to the grid. Left undefined where a tile
    // isn't clickable.
    onSelect?: () => void;
    ariaLabel?: string;
  } = $props();

  const isSelf = $derived(tile.identity === voice.localIdentity);
  const isScreen = $derived(tile.kind === 'screen');
  const track = $derived(isScreen ? tile.state.screenTrack : tile.state.cameraTrack);
  const ringColor = $derived(tile.member?.speakingRingColor ?? '#00d492');

  function attachVideo(node: HTMLVideoElement, current: VoiceVideoTrack) {
    current.attach(node);

    return {
      update(next: VoiceVideoTrack) {
        if (next === current) return;
        current.detach(node);
        current = next;
        current.attach(node);
      },
      destroy() {
        current.detach(node);
      },
    };
  }
</script>

<!-- `contents` removes the trigger box so the tile below is laid out by the stage directly -->
<ParticipantContextMenu {voice} identity={tile.identity} name={tile.name} class="contents">
  <svelte:element
    this={onSelect ? 'button' : 'div'}
    type={onSelect ? 'button' : undefined}
    role={onSelect ? 'button' : undefined}
    class={cn(
      'group/tile relative block overflow-hidden rounded-none border border-border bg-muted p-0 text-left',
      isScreen && 'bg-black',
      onSelect &&
        'cursor-pointer transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2',
      width === undefined && 'size-full'
    )}
    style:width={width === undefined ? undefined : `${width}px`}
    style:height={height === undefined ? undefined : `${height}px`}
    onclick={onSelect}
    aria-label={onSelect ? (ariaLabel ?? `Spotlight ${tile.name}`) : undefined}
  >
    {#if track}
      <!-- object-contain, not cover: never crop someone's camera to fit the tile shape -->
      <video
        class="size-full object-contain"
        autoplay
        playsinline
        muted={isSelf}
        use:attachVideo={track}
      ></video>
    {:else}
      <div
        class={cn(
          'flex size-full items-center justify-center',
          !tile.member?.avatarColor && fallbackAvatarBg(tile.identity)
        )}
        style:background-color={tile.member?.avatarColor}
      >
        <Avatar
          src={tile.member?.avatarUrl}
          name={tile.name}
          fallback={initialsFor(tile.name)}
          bgColor={tile.member?.avatarColor}
          class={cn(
            'rounded-full border-2 border-white/30 bg-black/20 text-white shadow-2xl ring-4 ring-black/10',
            compact ? 'size-10 text-sm' : 'size-16 text-xl sm:size-24 sm:text-2xl'
          )}
        />
      </div>
    {/if}

    <!-- speaking ring, drawn inside so it never changes the tile's box -->
    {#if tile.state.speaking}
      <div
        class="pointer-events-none absolute inset-0"
        style:box-shadow="inset 0 0 0 2px {ringColor}"
      ></div>
    {/if}

    <div
      class={cn(
        'absolute bottom-0 left-0 flex max-w-full items-center gap-1.5 bg-black/65 px-2 py-1 font-medium text-white backdrop-blur',
        compact ? 'text-[11px]' : 'text-xs sm:text-sm'
      )}
    >
      {#if isScreen}
        <MonitorUp class="size-3.5 shrink-0" />
      {/if}
      <span class="truncate">{tile.name}</span>
      {#if isSelf}
        <span class="shrink-0 text-white/70">(you)</span>
      {/if}
    </div>

    {#if !isScreen && (tile.state.selfMuted || tile.state.selfDeafened)}
      <div
        class={cn(
          'absolute bottom-1.5 right-1.5 flex items-center justify-center bg-rose-600 text-white',
          compact ? 'size-5' : 'size-7'
        )}
        class:rounded-full={settings.value.circleIcons}
      >
        {#if tile.state.selfDeafened}
          <HeadphoneOff class={compact ? 'size-3' : 'size-4'} />
        {:else}
          <MicOff class={compact ? 'size-3' : 'size-4'} />
        {/if}
      </div>
    {/if}
  </svelte:element>
</ParticipantContextMenu>
