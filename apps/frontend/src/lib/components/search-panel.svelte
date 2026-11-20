<script lang="ts">
  import { Hash, Paperclip, Search, X } from '@lucide/svelte';
  import { highlightMatches, searchWords } from 'anchor/message-search';
  import { Button } from '$lib/components/ui/button/index.js';
  import { chat } from '$lib/chat-state.svelte';
  import { formatDate } from '$lib/formatDate';
  import Avatar from './avatar.svelte';

  type Result = NonNullable<
    Awaited<ReturnType<typeof chat.searchMessages>>['data']
  >['messages'][number];

  let {
    query,
    guildId,
    channel,
    onClose,
  }: {
    query: string;
    guildId: string | null;
    channel: { id: string; name: string; type: string };
    onClose: () => void;
  } = $props();

  let wholeGuild = $state(true);
  let results = $state<Result[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let searched = $state('');
  const words = $derived(searchWords(searched));
  const scope = $derived(guildId && wholeGuild ? { guildId } : { channelId: channel.id });

  // a new query or scope starts over; older answers arriving late are dropped
  let request = 0;
  async function run(cursor: string | null = null) {
    const id = ++request;
    loading = true;
    error = null;
    const result = await chat.searchMessages(scope, query, cursor);
    if (id !== request) return;
    loading = false;
    if (result.error || !result.data) {
      const value = result.error?.value as { error?: string } | undefined;
      error = value?.error ?? 'Search failed';
      if (!cursor) results = [];
      return;
    }
    searched = query;
    results = cursor ? [...results, ...result.data.messages] : result.data.messages;
    nextCursor = result.data.nextCursor;
  }

  $effect(() => {
    void scope;
    if (query.trim()) void run();
  });

  function open(result: Result) {
    void chat.jumpToMessage(result.channelId, result.id);
    // on small screens the panel covers the chat, so it gets out of the way
    if (window.matchMedia('(max-width: 767px)').matches) onClose();
  }
</script>

<aside
  class="absolute inset-0 z-20 flex min-h-0 flex-col bg-background md:static md:w-md md:shrink-0 md:border-l md:border-border"
  aria-label="Search results"
>
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
    <Search class="size-4 text-muted-foreground" />
    <span class="truncate text-sm font-semibold text-foreground">
      {loading && !results.length
        ? 'Searching…'
        : `${results.length}${nextCursor ? '+' : ''} result${results.length === 1 ? '' : 's'}`}
    </span>
    <div class="flex-1"></div>
    {#if guildId}
      <div class="flex items-center gap-0.5" role="group" aria-label="Search in">
        <Button
          variant={wholeGuild ? 'secondary' : 'ghost'}
          size="xs"
          aria-pressed={wholeGuild}
          onclick={() => (wholeGuild = true)}
        >
          Server
        </Button>
        <Button
          variant={wholeGuild ? 'ghost' : 'secondary'}
          size="xs"
          aria-pressed={!wholeGuild}
          onclick={() => (wholeGuild = false)}
        >
          #{channel.name}
        </Button>
      </div>
    {/if}
    <Button variant="ghost" size="icon-sm" onclick={onClose} aria-label="Close search">
      <X class="size-4" />
    </Button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <p class="p-4 text-sm text-destructive">{error}</p>
    {:else if loading && !results.length}
      <div class="space-y-4 p-3">
        {#each Array.from({ length: 4 }) as _}
          <div class="space-y-2">
            <div class="h-3 w-24 animate-pulse bg-muted"></div>
            <div class="h-3 w-3/4 animate-pulse bg-muted"></div>
          </div>
        {/each}
      </div>
    {:else if !results.length}
      <div class="p-4 text-sm text-muted-foreground">
        <p class="font-medium text-foreground">No messages found</p>
        <p class="mt-1">
          Try other words, or filters like <code>from:alice</code>, <code>has:link</code>,
          <code>has:attachment</code>, <code>before:2026-01-31</code>,
          <code>after:2026-01-01</code>.
        </p>
      </div>
    {:else}
      <ul class="divide-y divide-border">
        {#each results as result (result.id)}
          {@const name = result.author.displayName || result.author.username}
          <li>
            <button
              type="button"
              class="flex w-full gap-3 px-3 py-2.5 text-left hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
              onclick={() => open(result)}
            >
              <Avatar
                src={result.author.avatarUrl}
                {name}
                class="mt-0.5 size-8 text-xs"
                bgColor={result.author.avatarColor}
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span class="truncate text-sm font-semibold text-foreground">{name}</span>
                  {#if result.guildId}
                    <span class="flex shrink-0 items-center">
                      <Hash class="size-3" />{result.channelName}
                    </span>
                  {/if}
                  <span class="ml-auto shrink-0">{formatDate(new Date(result.createdAt))}</span>
                </div>
                {#if result.content}
                  <p
                    class="line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground/90"
                  >
                    {#each highlightMatches(result.content, words) as piece}
                      {#if piece.match}
                        <mark class="bg-primary/25 text-foreground">{piece.text}</mark>
                      {:else}
                        {piece.text}
                      {/if}
                    {/each}
                  </p>
                {/if}
                {#if result.attachments.length}
                  <p class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Paperclip class="size-3" />
                    {result.attachments.map((attachment) => attachment.filename).join(', ')}
                  </p>
                {/if}
              </div>
            </button>
          </li>
        {/each}
      </ul>
      {#if nextCursor}
        <div class="p-3">
          <Button
            variant="outline"
            size="sm"
            class="w-full"
            disabled={loading}
            onclick={() => run(nextCursor)}
          >
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      {/if}
    {/if}
  </div>
</aside>
