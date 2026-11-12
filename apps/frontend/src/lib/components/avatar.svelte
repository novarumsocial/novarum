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
    status,
  }: {
    src?: string | null;
    name: string;
    class?: string;
    focused?: boolean;
    fallback?: string;
    bgColor?: string | null;
    status?: 'online' | 'offline';
  } = $props();

  let failed = $state(false);

  $effect(() => {
    src;
    failed = false;
  });

  // apparently colors dont generate on runtime so we need to do that style: thing
</script>

{#snippet face(classes: string)}
  <div
    class={cn(
      'flex shrink-0 items-center justify-center overflow-hidden font-bold select-none',
      bgColor ? 'text-white' : 'bg-secondary text-foreground',
      settings.value.circleIcons && 'rounded-full',
      classes
    )}
    style:background-color={bgColor || undefined}
    role="img"
    aria-label={status ? `${name}, ${status}` : name}
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
{/snippet}

{#if status}
  <div
    class={cn(
      'avatar-status relative shrink-0',
      settings.value.circleIcons && 'rounded-full',
      className
    )}
  >
    {@render face('avatar-notch size-full')}
    <span class="avatar-pip" data-status={status}></span>
  </div>
{:else}
  {@render face(className)}
{/if}
