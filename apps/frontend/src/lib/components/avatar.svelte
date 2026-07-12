<script lang="ts">
  // extremely overengineered avatar component to handle GIFs and frozen frames for them

  let {
    src,
    name,
    class: className = '',
    focused = true,
  }: {
    src?: string | null;
    name: string;
    class?: string;
    focused?: boolean;
  } = $props();

  let playGif = $state(focused);
  let failed = $state(false);
  let imgElement = $state<HTMLImageElement | null>(null);
  let frozenFrame = $state<HTMLCanvasElement | null>(null);
  let frozenReady = $state(false);
  let isGif = $derived(Boolean(src && /(\.gif(?:$|[?#])|[?&]format=gif(?:&|$))/i.test(src)));

  $effect(() => {
    src;
    failed = false;
    frozenReady = false;

    // maybe its not clean to put it here but idc
    playGif = focused;
  });

  $effect(() => {
    if (playGif) {
      frozenReady = false;
      return;
    }

    if (isGif && imgElement?.complete && frozenFrame) freezeGif();
  });

  function freezeGif() {
    if (playGif || !isGif || !imgElement || !frozenFrame) return;

    const size = 128;
    const scale = Math.max(size / imgElement.naturalWidth, size / imgElement.naturalHeight);
    const width = imgElement.naturalWidth * scale;
    const height = imgElement.naturalHeight * scale;

    frozenFrame.width = size;
    frozenFrame.height = size;
    frozenFrame
      .getContext('2d')
      ?.drawImage(imgElement, (size - width) / 2, (size - height) / 2, width, height);
    frozenReady = true;
  }
</script>

<div
  class="flex shrink-0 items-center justify-center overflow-hidden bg-primary/20 font-bold text-primary {className}"
  role="img"
  aria-label={name}
  onmouseenter={() => {
    if (isGif && !focused) playGif = true;
  }}
  onmouseleave={() => {
    if (isGif && !focused) playGif = false;
  }}
>
  {#if src && !failed}
    {#if isGif}
      <canvas
        bind:this={frozenFrame}
        class="size-full object-cover"
        class:hidden={playGif || !frozenReady}
        aria-hidden="true"
      ></canvas>
    {/if}
    {#if !isGif || playGif || !frozenReady}
      <img
        {src}
        alt=""
        class="size-full object-cover"
        class:hidden={isGif && !playGif}
        referrerpolicy="no-referrer"
        onerror={() => (failed = true)}
        onload={freezeGif}
        bind:this={imgElement}
      />
    {/if}
  {:else}
    {name.charAt(0).toUpperCase() || '?'}
  {/if}
</div>
