<script lang="ts">
  import '@videojs/html/audio/player';
  import '@videojs/html/audio/skin';
  import type { Attachment } from '$lib/types/chat';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Download } from '@lucide/svelte';
  import { cn } from '$lib/utils';

  let { attachment, hovered }: { attachment: Attachment; hovered: boolean } = $props();

  let player: HTMLElement | undefined = $state();

  // ponytail: pierce audio-skin's shadow DOM — skin vars set on the host are overridden
  // by .media-default-skin--audio's own declarations, so they must be set inside the
  // shadow root. Scoped to .media-controls so tooltips/menus keep their glass surface.
  $effect(() => {
    const controls = player
      ?.querySelector('audio-skin')
      ?.shadowRoot?.querySelector<HTMLElement>('.media-controls');
    if (!controls) return;
    controls.style.setProperty('--media-surface-outer-border-color', 'transparent');
    controls.style.setProperty('--media-surface-inner-border-color', 'transparent');
    controls.style.setProperty('--media-surface-shadow-color', 'transparent');
    controls.style.setProperty('--media-surface-backdrop-filter', 'none');
    controls.style.setProperty(
      '--media-surface-background-color',
      hovered ? 'color-mix(in oklab, var(--color-muted) 30%, transparent)' : 'var(--background)'
    );
  });
</script>

<div class="flex w-full flex-col gap-1.5">
  <audio-player bind:this={player} controls class="block w-full text-primary">
    <audio-skin>
      <audio src={attachment.url} preload="metadata" aria-label={attachment.filename}></audio>
    </audio-skin>
  </audio-player>
  <div class="flex items-center gap-1.5 pr-1">
    <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{attachment.filename}</span>
    <Button
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      download={attachment.filename}
      variant="ghost"
      size="icon-sm"
      class="shrink-0 text-muted-foreground hover:text-primary"
      aria-label={`Download ${attachment.filename}`}
    >
      <Download class="size-3.5" />
    </Button>
  </div>
</div>
