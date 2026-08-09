<script lang="ts">
  import { settings } from '$lib/settings.svelte';
  import AnimatedImage from './animated-image.svelte';

  let {
    src,
    name,
    class: className = '',
    focused = false,
    fallback,
    bgColor,
  }: {
    src?: string | null;
    name: string;
    class?: string;
    focused?: boolean;
    fallback?: string;
    bgColor?: string | null;
  } = $props();

  let failed = $state(false);

  $effect(() => {
    src;
    failed = false;
  });

  // apparently colors dont generate on runtime so we need to do that style: thing
</script>

<div
  class="flex shrink-0 items-center justify-center overflow-hidden font-bold text-white bg-primary/20 select-none {className}"
  class:rounded-full={settings.value.circleIcons}
  style:background-color={bgColor || undefined}
  role="img"
  aria-label={name}
>
  {#if src && !failed}
    <AnimatedImage
      {src}
      alt=""
      class="size-full"
      {focused}
      fit="contain"
      onerror={() => (failed = true)}
    />
  {:else}
    {fallback || name.charAt(0).toUpperCase() || '?'}
  {/if}
</div>
