<script lang="ts">
  let {
    src,
    alt = '',
    class: className = '',
    focused = true,
    fit = 'cover',
    onerror,
  }: {
    src: string;
    alt?: string;
    class?: string;
    focused?: boolean;
    fit?: 'cover' | 'contain';
    onerror?: () => void;
  } = $props();

  let play = $state(false);
  let image = $state<HTMLImageElement | null>(null);
  let frozenFrame = $state<HTMLCanvasElement | null>(null);
  let frozenReady = $state(false);
  const animated = $derived(
    /(\.gif(?:$|[?#])|[?&]format=gif(?:&|$)|[?&]animated=1(?:&|$))/i.test(src)
  );

  $effect(() => {
    src;
    play = focused;
    frozenReady = false;
  });

  $effect(() => {
    if (play) {
      frozenReady = false;
    } else if (animated && image?.complete && frozenFrame) {
      freeze();
    }
  });

  function freeze() {
    if (play || !animated || !image || !frozenFrame) return;

    const scale = Math.min(1, 512 / image.naturalWidth);
    frozenFrame.width = image.naturalWidth * scale;
    frozenFrame.height = image.naturalHeight * scale;
    frozenFrame.getContext('2d')?.drawImage(image, 0, 0, frozenFrame.width, frozenFrame.height);
    frozenReady = true;
  }
</script>

<div
  class="overflow-hidden {className}"
  role="presentation"
  onmouseenter={() => {
    if (animated && !focused) play = true;
  }}
  onmouseleave={() => {
    if (animated && !focused) play = false;
  }}
>
  {#if animated}
    <canvas
      bind:this={frozenFrame}
      class="size-full"
      class:object-cover={fit === 'cover'}
      class:object-contain={fit === 'contain'}
      class:hidden={play || !frozenReady}
      aria-hidden="true"
    ></canvas>
  {/if}
  {#if !animated || play || !frozenReady}
    <img
      {src}
      {alt}
      class="size-full"
      class:object-cover={fit === 'cover'}
      class:object-contain={fit === 'contain'}
      class:hidden={animated && !play}
      referrerpolicy="no-referrer"
      {onerror}
      onload={freeze}
      bind:this={image}
    />
  {/if}
</div>
