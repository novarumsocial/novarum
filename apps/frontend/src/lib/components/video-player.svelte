<script lang="ts">
  import '@videojs/html/video/player';
  import '@videojs/html/video/skin';
  import type { Attachment } from '$lib/types/chat';
  import { Download } from '@lucide/svelte';

  let { attachment }: { attachment: Attachment } = $props();

  let player: HTMLElement | undefined = $state();
  let download: HTMLAnchorElement | undefined = $state();

  // ponytail: the skin lives in a shadow root, so app styles can't reach it — adopt our own
  // sheet on top. Its rules are scoped as `.media-default-skin .x` (and `--video` for vars),
  // so ours need the extra `.media-default-skin--video` to out-specify them.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .media-default-skin.media-default-skin--video {
      --media-surface-background-color: var(--popover);
      --media-surface-outer-border-color: var(--border);
      --media-surface-inner-border-color: transparent;
      --media-surface-shadow-color: transparent;
      --media-surface-backdrop-filter: none;
      --media-color-primary: var(--popover-foreground);
      --media-tooltip-background-color: var(--popover);
      --media-tooltip-border-color: var(--border);
      --media-tooltip-text-color: var(--popover-foreground);
      --menu-item-border-radius: var(--radius);
    }
    .media-default-skin.media-default-skin--video :is(
      .media-surface, .media-controls, .media-button, .media-badge, .media-tooltip,
      .media-slider__track, .media-slider__fill, .media-slider__buffer
    ) { border-radius: var(--radius); }
    .media-default-skin.media-default-skin--video .media-surface:after { border-radius: var(--radius); }
    .media-default-skin.media-default-skin--video .media-button { text-shadow: none; }
    .media-default-skin.media-default-skin--video { width: 100%; height: 100%; min-height: 0; }
    /* The library keeps the controls up for as long as a clip is paused, which in a chat means
       always. Here they only show while you point at (or tab into) the player; a paused clip
       shows a plain play mark instead. */
    :host(:not(:hover):not(:focus-within)) .media-controls {
      opacity: 0;
      pointer-events: none;
    }
    :host(:not(:hover):not(:focus-within)) .media-default-skin:has(.media-button--play[data-paused])::after {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 1;
      margin: auto;
      width: 3.5rem;
      height: 3.5rem;
      border-radius: var(--radius);
      background: rgb(0 0 0 / 0.6) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M8 5v14l11-7z'/%3E%3C/svg%3E") center / 1.75rem no-repeat;
      pointer-events: none;
    }
  `);

  $effect(() => {
    const root = player?.querySelector('video-skin')?.shadowRoot;
    if (root && !root.adoptedStyleSheets.includes(sheet))
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    // move our download link into the skin's control bar, right before fullscreen
    if (download) root?.querySelector('.media-button--fullscreen')?.before(download);
  });
</script>

<video-player bind:this={player} controls playsinline class="[--media-border-radius:var(--radius)]">
  <!-- video-player has no box of its own; the skin is what gets sized. It's always a 16:9 box
       with the clip fitted inside, so portrait videos stay small and the controls always fit. -->
  <video-skin class="aspect-video w-full overflow-hidden rounded-none bg-black">
    <video
      src={attachment.url}
      poster={attachment.previewUrl}
      preload="metadata"
      aria-label={attachment.filename}
      class="size-full object-contain"
    ></video>
    <img
      slot="poster"
      src={attachment.previewUrl}
      alt={attachment.filename}
      class="size-full object-contain"
    />
  </video-skin>
</video-player>

<a
  bind:this={download}
  href={attachment.url}
  target="_blank"
  rel="noreferrer"
  download={attachment.filename}
  class="media-button media-button--subtle media-button--icon"
  aria-label={`Download ${attachment.filename}`}
>
  <Download class="media-icon" />
</a>
