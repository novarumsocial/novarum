<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    children,
  }: { title?: string; description?: string; children: Snippet } = $props();
</script>

<section class="grid gap-2.5">
  {#if title}
    <div>
      <h3 class="text-sm font-medium">{title}</h3>
      {#if description}
        <p class="text-xs text-muted-foreground">{description}</p>
      {/if}
    </div>
  {/if}
  <div class="divide-y divide-border/60 bg-card">{@render children()}</div>
</section>
