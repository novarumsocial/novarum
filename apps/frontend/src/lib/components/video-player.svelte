<script lang="ts">
  import '@videojs/html/video/player';
  import '@videojs/html/video/skin';
  import type { Attachment } from '$lib/types/chat';

  let { attachment }: { attachment: Attachment } = $props();
</script>

<video-player
  controls
  playsinline
  class="block aspect-video w-full overflow-hidden rounded-md bg-black [--media-border-radius:0.5rem]"
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
