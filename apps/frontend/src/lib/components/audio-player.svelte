<script lang="ts">
  import '@videojs/html/audio/player';
  import '@videojs/html/audio/skin';
  import type { Attachment } from '$lib/types/chat';

  let { attachment }: { attachment: Attachment } = $props();
</script>

<audio-player
  controls
  class="block w-full bg-background text-primary"
  style="--media-surface-background-color: var(--background)"
>
  <audio-skin>
    <audio src={attachment.url} preload="metadata" aria-label={attachment.filename}></audio>
  </audio-skin>
</audio-player>