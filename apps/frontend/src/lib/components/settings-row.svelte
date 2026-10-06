<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Label } from '$lib/components/ui/label/index.js';
  import { cn } from '$lib/utils';

  // `stacked` puts the control under the text, for wide controls like selects and sliders
  let {
    title,
    description,
    id,
    stacked = false,
    children,
  }: {
    title: string;
    description?: string;
    id?: string;
    stacked?: boolean;
    children: Snippet;
  } = $props();
</script>

<div
  class={cn('flex gap-3 px-4 py-3.5', stacked ? 'flex-col' : 'items-center justify-between gap-4')}
>
  <div class="min-w-0">
    <Label for={id} class="text-sm font-medium">{title}</Label>
    {#if description}
      <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
    {/if}
  </div>
  <div class={stacked ? 'w-full' : 'shrink-0'}>{@render children()}</div>
</div>
