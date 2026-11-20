<script lang="ts">
  import { Search } from '@lucide/svelte';
  import { applySearchSuggestion, searchSuggestions } from 'anchor/message-search';
  import { chat } from '$lib/chat-state.svelte';
  import { messageSearch } from '$lib/search.svelte';
  import { cn } from '$lib/utils';
  import * as InputGroup from '$lib/components/ui/input-group/index.js';

  let { placeholder, class: className }: { placeholder: string; class?: string } = $props();

  let input = $state<HTMLInputElement | null>(null);
  let focused = $state(false);
  // nothing is picked until the arrows move, so Enter still searches
  let active = $state(-1);
  const suggestions = $derived(
    focused ? searchSuggestions(messageSearch.text, chat.activeServer ? chat.members : []) : []
  );

  function pick(index: number) {
    messageSearch.text = applySearchSuggestion(messageSearch.text, suggestions[index]!);
    active = -1;
    input?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      messageSearch.query = null;
      input?.blur();
    } else if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + suggestions.length) % suggestions.length;
    } else if (active >= 0 && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      pick(active);
    }
  }

  // Ctrl/Cmd+K, as the browser's own Ctrl+F stays find-in-page; only the box on screen takes it
  function onWindowKeydown(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
    if (!input?.offsetParent) return;
    event.preventDefault();
    input.focus();
    input.select();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<form
  class={cn('relative', className)}
  onsubmit={(event) => {
    event.preventDefault();
    if (messageSearch.text.trim()) messageSearch.query = messageSearch.text.trim();
  }}
>
  <InputGroup.Root class="h-8">
    <InputGroup.Input
      bind:ref={input}
      bind:value={messageSearch.text}
      type="search"
      {placeholder}
      aria-label="Search messages"
      title="Search messages (Ctrl+K)"
      autocomplete="off"
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      oninput={() => (active = -1)}
      onkeydown={onKeydown}
    />
    <InputGroup.Addon>
      <Search />
    </InputGroup.Addon>
  </InputGroup.Root>
  {#if suggestions.length}
    <div
      class="absolute top-full right-0 z-50 mt-1 w-64 border border-border bg-popover p-1 text-popover-foreground shadow-md"
      role="listbox"
      aria-label="Search filters"
    >
      {#if !/:/.test(messageSearch.text.split(/\s/).at(-1) ?? '')}
        <div class="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase">
          Search options
        </div>
      {/if}
      {#each suggestions as suggestion, index (suggestion.value)}
        <button
          type="button"
          role="option"
          aria-selected={index === active}
          class={cn(
            'flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent',
            index === active && 'bg-accent'
          )}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => pick(index)}
        >
          <span class="font-medium">{suggestion.label}</span>
          <span class="truncate text-xs text-muted-foreground">{suggestion.detail}</span>
        </button>
      {/each}
    </div>
  {/if}
</form>
