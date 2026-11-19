<script lang="ts">
  import { Search } from '@lucide/svelte';
  import { messageSearch } from '$lib/search.svelte';
  import * as InputGroup from '$lib/components/ui/input-group/index.js';

  let { placeholder, class: className }: { placeholder: string; class?: string } = $props();

  let input = $state<HTMLInputElement | null>(null);

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
  class={className}
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
      onkeydown={(event) => {
        if (event.key !== 'Escape') return;
        messageSearch.query = null;
        input?.blur();
      }}
    />
    <InputGroup.Addon>
      <Search />
    </InputGroup.Addon>
  </InputGroup.Root>
</form>
