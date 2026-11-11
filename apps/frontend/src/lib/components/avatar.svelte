<script lang="ts">
  import { settings } from '$lib/settings.svelte';
  import { cn } from '$lib/utils';
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
  class={cn(
    'flex shrink-0 items-center justify-center overflow-hidden font-bold select-none',
    bgColor ? 'text-white' : 'bg-secondary text-foreground',
    settings.value.circleIcons && 'rounded-pill',
    className
  )}
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
