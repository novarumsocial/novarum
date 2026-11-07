<script lang="ts">
  import type { ActionRow } from 'anchor/bot-schemas';
  import { ExternalLink, LoaderCircle } from '@lucide/svelte';
  import { Button, type ButtonVariant } from '$lib/components/ui/button/index.js';
  import { interactions } from '$lib/bots.svelte';
  import { cn } from '$lib/utils';

  let { rows, channelId, messageId }: { rows: ActionRow[]; channelId: string; messageId: string } =
    $props();

  let error = $state<string | null>(null);

  const variants: Record<string, { variant: ButtonVariant; class?: string }> = {
    primary: { variant: 'default' },
    secondary: { variant: 'secondary' },
    success: { variant: 'default', class: 'bg-emerald-600 text-white hover:bg-emerald-600/85' },
    danger: { variant: 'default', class: 'bg-destructive text-white hover:bg-destructive/85' },
    link: { variant: 'outline' },
  };

  async function press(customId: string) {
    error = await interactions.pressButton(channelId, messageId, customId);
  }
</script>

<div class="mt-1.5 flex flex-col gap-1.5">
  {#each rows as row, rowIndex (rowIndex)}
    <div class="flex flex-wrap gap-1.5">
      {#each row.components as button, index (index)}
        {@const look = variants[button.style]!}
        {#if button.style === 'link'}
          <Button
            href={button.disabled ? undefined : button.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            variant={look.variant}
            size="sm"
            disabled={button.disabled}
          >
            {button.label}
            <ExternalLink class="size-3" />
          </Button>
        {:else}
          {@const busy = interactions.pressing === `${messageId}:${button.customId}`}
          <Button
            variant={look.variant}
            size="sm"
            class={cn(look.class)}
            disabled={button.disabled || !!interactions.pressing}
            aria-busy={busy}
            onclick={() => press(button.customId)}
          >
            {#if busy}<LoaderCircle class="size-3 animate-spin" />{/if}
            {button.label}
          </Button>
        {/if}
      {/each}
    </div>
  {/each}
  {#if error}
    <p class="text-xs text-destructive" role="alert">{error}</p>
  {/if}
</div>
