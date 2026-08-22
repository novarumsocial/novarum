<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { HTMLAttributes } from 'svelte/elements';

  let { class: className, children, ...rest }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
  {...rest}
  data-slot="emoji-picker-viewport"
  class={cn('border-border rounded-none border', className)}
>
  {@render children?.()}
</div>
