<script lang="ts">
  import { cn } from '$lib/utils';
  import { settings } from '$lib/settings.svelte';
  let { class: className = '' }: { class?: string } = $props();
</script>

<span
  class={cn(
    'inline-flex h-4 shrink-0 items-center bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground select-none',
    className
  )}
  class:rounded-sm={settings.value.circleIcons}
  title="This account is a bot"
>
  BOT
</span>
