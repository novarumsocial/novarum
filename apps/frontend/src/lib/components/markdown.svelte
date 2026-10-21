<script lang="ts">
  import type { Snippet } from 'svelte';
  import { parseInline, parseMarkdown, type Block, type Inline } from '$lib/markdown';
  import EmojiText from './emoji-text.svelte';
  import { linkTarget } from '$lib/utils';

  // `inline` flattens everything to one line (reply previews); `compact` shrinks and truncates headings (profile cards);
  // `trailing` goes at the end of the last paragraph ("(edited)")
  let {
    content,
    links = false,
    inline = false,
    compact = false,
    trailing,
  }: {
    content: string;
    links?: boolean;
    inline?: boolean;
    compact?: boolean;
    trailing?: Snippet;
  } = $props();

  const blocks = $derived(inline ? [] : parseMarkdown(content));
  const headings = $derived(
    compact
      ? ['truncate text-sm font-bold', 'truncate text-sm font-semibold', 'truncate font-semibold']
      : ['text-xl font-bold', 'text-lg font-bold', 'text-base font-semibold']
  );
</script>

{#snippet spans(nodes: Inline[])}
  {#each nodes as node, index (index)}
    {#if node.type === 'text'}
      <EmojiText content={node.text} {links} />
    {:else if node.type === 'code'}
      <code class="rounded-[3px] bg-muted px-1 py-0.5 font-mono text-[0.85em]">{node.text}</code>
    {:else if node.type === 'bold'}
      <strong class="font-semibold">{@render spans(node.children)}</strong>
    {:else if node.type === 'italic'}
      <em>{@render spans(node.children)}</em>
    {:else if node.type === 'underline'}
      <u class="underline-offset-2">{@render spans(node.children)}</u>
    {:else if node.type === 'strike'}
      <s>{@render spans(node.children)}</s>
    {:else if node.type === 'spoiler'}
      <span
        role="button"
        tabindex="0"
        title="Spoiler"
        class="rounded-[3px] bg-muted-foreground/20 transition-colors not-data-revealed:cursor-pointer not-data-revealed:bg-muted-foreground not-data-revealed:text-transparent not-data-revealed:**:invisible"
        onclick={(event) => (event.currentTarget.dataset.revealed = '')}
        onkeydown={(event) => event.key === 'Enter' && (event.currentTarget.dataset.revealed = '')}
        >{@render spans(node.children)}</span
      >
    {:else if node.type === 'link' && links}
      <a
        href={node.url}
        title={node.url}
        target={linkTarget(node.url)}
        rel="noreferrer"
        class="text-link underline underline-offset-2 transition-colors hover:text-link/80"
        >{@render spans(node.children)}</a
      >
    {:else}
      {@render spans(node.children)}
    {/if}
  {/each}
{/snippet}

{#snippet render(blocks: Block[], last: boolean)}
  {#each blocks as block, index (index)}
    {@const end = last && index === blocks.length - 1}
    {#if block.type === 'paragraph'}
      <p class="whitespace-pre-wrap">
        {@render spans(block.children)}{#if end}{@render trailing?.()}{/if}
      </p>
    {:else if block.type === 'heading'}
      <p class="{headings[block.level - 1]} mt-1 leading-snug text-foreground">
        {@render spans(block.children)}{#if end}{@render trailing?.()}{/if}
      </p>
    {:else if block.type === 'code'}
      <pre
        class="my-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-[0.85em] leading-normal whitespace-pre"><code
          >{block.text}</code
        ></pre>
    {:else if block.type === 'quote'}
      <blockquote class="border-l-3 border-muted-foreground/40 pl-3">
        {@render render(block.children, end)}
      </blockquote>
    {:else}
      <svelte:element
        this={block.ordered ? 'ol' : 'ul'}
        start={block.start}
        class="{block.ordered ? 'list-decimal' : 'list-disc'} pl-6 marker:text-muted-foreground"
      >
        {#each block.items as item, itemIndex (itemIndex)}
          <li class="whitespace-pre-wrap">{@render spans(item)}</li>
        {/each}
      </svelte:element>
    {/if}
    {#if end && block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'quote'}
      {@render trailing?.()}
    {/if}
  {/each}
{/snippet}

{#if inline}
  {@render spans(parseInline(content.replace(/\s+/g, ' ')))}
{:else}
  <div class="break-words">
    {@render render(blocks, true)}{#if !blocks.length}{@render trailing?.()}{/if}
  </div>
{/if}
