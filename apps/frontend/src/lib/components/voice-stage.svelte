<script lang="ts">
  import {
    PanelBottomClose,
    PanelBottomOpen,
    PanelRightClose,
    PanelRightOpen,
  } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { cn } from '$lib/utils';
  import { settings } from '$lib/settings.svelte';
  import type { Voice } from '$lib/voice.svelte';
  import { fitTiles, type VoiceTile } from '$lib/voice-layout';
  import VoiceTileView from './voice-tile.svelte';

  let {
    tiles,
    voice,
    spotlightKey,
    onFocus,
    onExitSpotlight,
  }: {
    tiles: VoiceTile[];
    voice: Voice;
    spotlightKey: string | null;
    // Clicking a grid or filmstrip tile spotlights it, Discord-style.
    onFocus: (key: string) => void;
    // Clicking the spotlighted tile itself goes back to the grid.
    onExitSpotlight: () => void;
  } = $props();

  const GAP = 8;

  // Measured on the padding-free wrapper below, so this is exactly the area tiles may use.
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  let spotlightWidth = $state(0);
  let spotlightHeight = $state(0);

  // Whether the filmstrip of everyone else is collapsed away, leaving the spotlight full size.
  let stripCollapsed = $state(false);

  const spotlight = $derived(tiles.find((tile) => tile.key === spotlightKey) ?? null);
  const rest = $derived(spotlight ? tiles.filter((tile) => tile.key !== spotlight.key) : tiles);

  // Landscape puts the filmstrip on the side, portrait along the bottom. Driven by the
  // measured stage rather than breakpoints, so phone landscape behaves too.
  const sideStrip = $derived(stageWidth > stageHeight * 1.1);

  // Locked to 16:9 like Discord; narrow stages let tiles flex so they don't shrink to slivers.
  const tileAspect = $derived(stageWidth < 640 ? [1, 2] : [16 / 9, 16 / 9]);
  const grid = $derived(
    fitTiles(stageWidth, stageHeight, tiles.length, GAP, tileAspect[0], tileAspect[1])
  );
  const overflows = $derived(grid.rows * (grid.height + GAP) - GAP > stageHeight + 1);

  function onKeydown(event: KeyboardEvent) {
    if (event.key.toLowerCase() !== 'h' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!spotlight || rest.length === 0) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, select, [contenteditable="true"]')
    ) {
      return;
    }

    event.preventDefault();
    stripCollapsed = !stripCollapsed;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex min-h-0 min-w-0 flex-1 p-2 sm:p-3">
  <div
    bind:clientWidth={stageWidth}
    bind:clientHeight={stageHeight}
    class={cn('flex min-h-0 min-w-0 flex-1', spotlight && sideStrip ? 'flex-row' : 'flex-col')}
  >
    {#if spotlight}
      <div
        bind:clientWidth={spotlightWidth}
        bind:clientHeight={spotlightHeight}
        class="group relative flex min-h-0 min-w-0 flex-1 items-center justify-center"
      >
        <VoiceTileView
          tile={spotlight}
          {voice}
          fitWithin={{ width: spotlightWidth, height: spotlightHeight }}
          onSelect={onExitSpotlight}
          ariaLabel="Show grid view"
        />

        {#if rest.length > 0}
          <button
            type="button"
            class={cn(
              'absolute z-10 flex h-7 items-center gap-1.5 bg-black/60 px-2 text-xs font-medium text-white backdrop-blur transition-opacity hover:bg-black/75 focus-visible:opacity-100',
              sideStrip ? 'top-2 right-2' : 'right-2 bottom-2',
              settings.value.circleIcons && 'rounded-full',
              !stripCollapsed && 'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100'
            )}
            aria-label={stripCollapsed ? 'Show participants (H)' : 'Hide participants (H)'}
            title={stripCollapsed ? 'Show participants (H)' : 'Hide participants (H)'}
            aria-expanded={!stripCollapsed}
            onclick={() => (stripCollapsed = !stripCollapsed)}
          >
            {#if sideStrip}
              {#if stripCollapsed}
                <PanelRightOpen class="size-3.5" />
              {:else}
                <PanelRightClose class="size-3.5" />
              {/if}
            {:else if stripCollapsed}
              <PanelBottomOpen class="size-3.5" />
            {:else}
              <PanelBottomClose class="size-3.5" />
            {/if}
            {#if stripCollapsed}
              <span>{rest.length}</span>
            {/if}
          </button>
        {/if}
      </div>

      {#if rest.length > 0 && !stripCollapsed}
        <div
          class={cn(
            'flex shrink-0 gap-2 overscroll-contain',
            sideStrip ? 'ml-2 w-40 flex-col overflow-y-auto' : 'mt-2 h-24 overflow-x-auto'
          )}
          transition:slide={{ axis: sideStrip ? 'x' : 'y', duration: 200, easing: cubicOut }}
        >
          {#each rest as tile (tile.key)}
            <div class={cn('aspect-video shrink-0', sideStrip ? 'w-full' : 'h-full')}>
              <VoiceTileView {tile} {voice} compact onSelect={() => onFocus(tile.key)} />
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div
        class={cn(
          'flex min-h-0 min-w-0 flex-1 flex-wrap items-center justify-center gap-2',
          overflows ? 'content-start overflow-y-auto overscroll-contain' : 'content-center'
        )}
      >
        {#each tiles as tile (tile.key)}
          <VoiceTileView
            {tile}
            {voice}
            width={grid.width}
            height={grid.height}
            onSelect={() => onFocus(tile.key)}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>
