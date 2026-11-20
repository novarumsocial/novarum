<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { realtime } from '$lib/realtime.svelte';
  import EmojiText from './emoji-text.svelte';

  let {
    open = $bindable(false),
    onPick,
    trigger,
  }: {
    open?: boolean;
    onPick: (emoji: string) => void;
    trigger: Snippet<[{ props: Record<string, unknown> }]>;
  } = $props();

  const quickEmojis = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];
  let query = $state('');
  // the same search the message input's :emoji: suggestions use
  const results = $derived(
    query.trim() && realtime.emojiQuery.trim() === query.trim() ? realtime.emojiResults : []
  );

  $effect(() => {
    if (query.trim()) realtime.searchEmojis(query);
  });
  $effect(() => {
    if (!open) query = '';
  });

  const glyph = (unicode: string) =>
    String.fromCodePoint(...unicode.split('-').map((part) => parseInt(part, 16)));

  function pick(emoji: string) {
    onPick(emoji);
    open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      {@render trigger({ props })}
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-64 gap-2 p-2" align="end">
    <Input
      bind:value={query}
      placeholder="Search emoji"
      aria-label="Search emoji"
      class="h-7 text-xs"
      onkeydown={(event) => {
        if (event.key === 'Enter' && results[0]) pick(glyph(results[0].unicode));
      }}
    />
    <div class="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto" role="listbox">
      {#if query.trim()}
        {#each results as emoji (emoji.unicode)}
          <Button
            variant="ghost"
            size="icon-xs"
            role="option"
            aria-selected="false"
            title={`:${emoji.name.toLowerCase().replaceAll(' ', '_')}:`}
            onclick={() => pick(glyph(emoji.unicode))}
          >
            <img src={emoji.url} alt={glyph(emoji.unicode)} class="size-5 object-contain" />
          </Button>
        {:else}
          <p class="col-span-8 py-2 text-center text-muted-foreground">No emoji found</p>
        {/each}
      {:else}
        {#each quickEmojis as emoji (emoji)}
          <Button
            variant="ghost"
            size="icon-xs"
            role="option"
            aria-selected="false"
            aria-label={`React with ${emoji}`}
            class="text-base"
            onclick={() => pick(emoji)}
          >
            <EmojiText content={emoji} />
          </Button>
        {/each}
      {/if}
    </div>
  </Popover.Content>
</Popover.Root>
