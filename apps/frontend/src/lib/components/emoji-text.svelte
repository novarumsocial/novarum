<script lang="ts">
  import { realtime } from '$lib/realtime.svelte';
  import { isUrl, urlPattern } from '$lib/utils';

  let { content, links = false }: { content: string; links?: boolean } = $props();

  type Part = { text: string; url?: boolean; unicode?: string };

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const parts = $derived(
    content.split(urlPattern).flatMap<Part>((text) => {
      if (links && isUrl(text)) return [{ text, url: true }];

      return [...segmenter.segment(text)].map(({ segment }) => ({
        text: segment,
        unicode: /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)
          ? [...segment]
              .map((character) => character.codePointAt(0)!.toString(16).toUpperCase())
              .join('-')
          : undefined,
      }));
    })
  );

  $effect(() => {
    realtime.queryEmojis(parts.flatMap((part) => (part.unicode ? [part.unicode] : [])));
  });
</script>

{#each parts as part, index (index)}
  {#if part.url}
    <a
      href={part.text}
      target="_blank"
      rel="noreferrer"
      class="text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
      >{part.text}</a
    >
  {:else if part.unicode && realtime.emojiUrls[part.unicode]}
    <img
      src={realtime.emojiUrls[part.unicode]}
      alt={part.text}
      title={part.text}
      class="inline-block size-[1.35em] object-contain align-[-0.25em]"
    />
  {:else}
    {part.text}
  {/if}
{/each}
