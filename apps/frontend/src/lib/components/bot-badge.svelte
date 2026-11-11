<script lang="ts">
  import { cn } from '$lib/utils';

  let { class: className = '' }: { class?: string } = $props();
</script>

<span
  class={cn(
    'inline-flex h-4 shrink-0 items-center border border-current px-1 text-[10px] leading-none font-semibold text-muted-foreground select-none',
    className
  )}
  title="This account is a bot"
>
  Bot
</span>
