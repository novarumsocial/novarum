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
  `);

  $effect(() => {
    const root = player?.querySelector('video-skin')?.shadowRoot;
    if (root && !root.adoptedStyleSheets.includes(sheet))
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    // move our download link into the skin's control bar, right before fullscreen
    if (download) root?.querySelector('.media-button--fullscreen')?.before(download);
  });
</script>

<video-player
  bind:this={player}
  controls
  playsinline
  class="block aspect-video w-full overflow-hidden rounded-lg border border-border bg-black [--media-border-radius:0.5rem]"
>
  <video-skin>
    <video
      src={attachment.url}
      poster={attachment.previewUrl}
      preload="metadata"
      aria-label={attachment.filename}
    ></video>
    <img slot="poster" src={attachment.previewUrl} alt={attachment.filename} />
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
