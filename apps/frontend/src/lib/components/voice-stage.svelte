<script lang="ts">
  import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from '@lucide/svelte';
  import { cn } from '$lib/utils';
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

  // Whether the filmstrip of everyone else is collapsed away, leaving the spotlight full size.
  let stripCollapsed = $state(false);

  const spotlight = $derived(tiles.find((tile) => tile.key === spotlightKey) ?? null);
  const rest = $derived(spotlight ? tiles.filter((tile) => tile.key !== spotlight.key) : tiles);

  // Landscape puts the filmstrip on the side, portrait along the bottom. Driven by the
  // measured stage rather than breakpoints, so phone landscape behaves too.
  const sideStrip = $derived(stageWidth > stageHeight * 1.1);

  const grid = $derived(fitTiles(stageWidth, stageHeight, tiles.length, GAP));
  const overflows = $derived(grid.rows * (grid.height + GAP) - GAP > stageHeight + 1);
</script>

<div class="flex min-h-0 min-w-0 flex-1 p-2 sm:p-3">
  <div
    bind:clientWidth={stageWidth}
    bind:clientHeight={stageHeight}
    class={cn(
      'flex min-h-0 min-w-0 flex-1 gap-2',
      spotlight && sideStrip ? 'flex-row' : 'flex-col'
    )}
  >
    {#if spotlight}
      <div class="flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <VoiceTileView
          tile={spotlight}
          {voice}
          onSelect={onExitSpotlight}
          ariaLabel="Show grid view"
        />
      </div>

      {#if rest.length > 0}
        <div class={cn('flex shrink-0 gap-1', sideStrip ? 'flex-row' : 'flex-col')}>
          <button
            type="button"
            class={cn(
              'flex shrink-0 items-center justify-center border border-border bg-sidebar/40 text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground',
              sideStrip ? 'w-5' : 'h-5'
            )}
            aria-label={stripCollapsed ? 'Show participants' : 'Hide participants'}
            aria-expanded={!stripCollapsed}
            onclick={() => (stripCollapsed = !stripCollapsed)}
          >
            {#if sideStrip}
              {#if stripCollapsed}
                <ChevronLeft class="size-3.5" />
              {:else}
                <ChevronRight class="size-3.5" />
              {/if}
            {:else if stripCollapsed}
              <ChevronUp class="size-3.5" />
            {:else}
              <ChevronDown class="size-3.5" />
            {/if}
          </button>

          {#if !stripCollapsed}
            <div
              class={cn(
                'flex shrink-0 gap-2 overscroll-contain',
                sideStrip ? 'w-40 flex-col overflow-y-auto' : 'h-24 overflow-x-auto'
              )}
            >
              {#each rest as tile (tile.key)}
                <div class={cn('aspect-video shrink-0', sideStrip ? 'w-full' : 'h-full')}>
                  <VoiceTileView {tile} {voice} compact onSelect={() => onFocus(tile.key)} />
                </div>
              {/each}
            </div>
          {/if}
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
