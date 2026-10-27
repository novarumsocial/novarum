<script lang="ts">
  import { Headphones } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import MicLevelMeter from './mic-level-meter.svelte';
  import type { Voice } from '$lib/voice.svelte';

  let { voice }: { voice: Voice } = $props();

  let pending = $state(false);
  let error = $state<string | null>(null);

  $effect(() => () => void voice.setAudioLoopbackTesting(false));

  async function toggle() {
    pending = true;
    error = null;

    try {
      await voice.setAudioLoopbackTesting(!voice.audioLoopbackTesting);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown playback error';
    } finally {
      pending = false;
    }
  }
</script>

<div class="flex items-center gap-2">
  <Button
    class="flex-1"
    size="sm"
    variant={voice.audioLoopbackTesting ? 'secondary' : 'outline'}
    disabled={pending}
    aria-pressed={voice.audioLoopbackTesting}
    onclick={toggle}
  >
    <Headphones data-icon="inline-start" />
    {pending
      ? voice.audioLoopbackTesting
        ? 'Starting...'
        : 'Stopping...'
      : voice.audioLoopbackTesting
        ? 'Stop test'
        : 'Start test'}
  </Button>
  <MicLevelMeter stream={voice.audioLoopbackStream} />
</div>
{#if error}
  <p
    class="mt-2 border border-destructive/20 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
  >
    {error}
  </p>
{/if}
