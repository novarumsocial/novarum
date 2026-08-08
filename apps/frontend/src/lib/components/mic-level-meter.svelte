<script lang="ts">
  const N = 20;
  let { stream }: { stream: MediaStream | null } = $props();

  let level = $state(0);
  let raf = 0;

  $effect(() => {
    if (!stream) {
      level = 0;
      return;
    }

    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    context.createMediaStreamSource(stream).connect(analyser);

    const data = new Uint8Array(analyser.fftSize);

    function tick() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) {
        const value = sample / 128 - 1;
        sum += value * value;
      }
      level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      raf = requestAnimationFrame(tick);
    }
    tick();

    return () => {
      cancelAnimationFrame(raf);
      context.close().catch(() => undefined);
    };
  });

  const litCount = $derived(Math.round(level * N));

  // yellow -> green -> red
  function barColor(i: number): string {
    const t = i / (N - 1);
    if (t < 0.7) return 'hsl(142 70% 45%)';  // green  -> most of the bar
    if (t < 0.9) return 'hsl(45 90% 55%)';   // yellow -> getting loud
    return 'hsl(0 80% 55%)';                 // red    -> too loud bro, lower your voice!!! mom's gonna wake up :(
  }
</script>

<div class="flex h-5 items-end gap-[3px]">
  {#each Array(N) as _, i}
    <div
      class="h-5 w-[3px] rounded-[1px] transition-colors duration-100 ease-out {i >= litCount
        ? 'bg-muted-foreground/25'
        : ''}"
      style:background-color={i < litCount ? barColor(i) : undefined}
    ></div>
  {/each}
</div>
