<script lang="ts">
  import type { Embed } from 'anchor/bot-schemas';
  import Markdown from './markdown.svelte';
  import { formatDate, formatTime } from '$lib/formatDate';

  let { embed }: { embed: Embed } = $props();

  // the bot picks the colour of the bar; without one it is the quiet border colour
  const accent = $derived(
    embed.color === undefined ? undefined : `#${embed.color.toString(16).padStart(6, '0')}`
  );
  const timestamp = $derived(embed.timestamp ? new Date(embed.timestamp) : null);
  const external = { target: '_blank', rel: 'noopener noreferrer nofollow' };
</script>

<article
  class="mt-1.5 grid max-w-lg grid-cols-[1fr_auto] gap-x-4 rounded-2xl border-l-4 border-border bg-card py-3 pr-4 pl-3.5"
  style:border-left-color={accent}
>
  <div class="min-w-0">
    {#if embed.author}
      <div class="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        {#if embed.author.iconUrl}
          <img
            src={embed.author.iconUrl}
            alt=""
            class="size-5 object-cover"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
        {/if}
        {#if embed.author.url}
          <a href={embed.author.url} {...external} class="truncate hover:underline"
            >{embed.author.name}</a
          >
        {:else}
          <span class="truncate">{embed.author.name}</span>
        {/if}
      </div>
    {/if}

    {#if embed.title}
      <h3 class="text-sm font-semibold break-words">
        {#if embed.url}
          <a href={embed.url} {...external} class="text-link hover:underline">{embed.title}</a>
        {:else}
          {embed.title}
        {/if}
      </h3>
    {/if}

    {#if embed.description}
      <div class="mt-1 text-sm leading-relaxed text-foreground/85">
        <Markdown content={embed.description} links />
      </div>
    {/if}

    {#if embed.fields?.length}
      <dl class="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        {#each embed.fields as field, index (index)}
          <div class={field.inline ? 'min-w-0' : 'min-w-0 sm:col-span-3'}>
            <dt class="text-xs font-semibold">{field.name}</dt>
            <dd class="text-sm text-foreground/85"><Markdown content={field.value} links /></dd>
          </div>
        {/each}
      </dl>
    {/if}
  </div>

  {#if embed.thumbnail}
    <img
      src={embed.thumbnail.url}
      alt=""
      class="row-span-2 size-20 object-cover"
      loading="lazy"
      referrerpolicy="no-referrer"
    />
  {/if}

  {#if embed.image}
    <img
      src={embed.image.url}
      alt=""
      class="col-span-2 mt-2.5 max-h-80 w-auto max-w-full object-contain"
      loading="lazy"
      referrerpolicy="no-referrer"
    />
  {/if}

  {#if embed.footer || timestamp}
    <footer class="col-span-2 mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {#if embed.footer?.iconUrl}
        <img
          src={embed.footer.iconUrl}
          alt=""
          class="size-4 object-cover"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
      {/if}
      {#if embed.footer}<span class="truncate">{embed.footer.text}</span>{/if}
      {#if embed.footer && timestamp}<span aria-hidden="true">•</span>{/if}
      {#if timestamp}
        <time datetime={timestamp.toISOString()}
          >{formatDate(timestamp)} at {formatTime(timestamp)}</time
        >
      {/if}
    </footer>
  {/if}
</article>
