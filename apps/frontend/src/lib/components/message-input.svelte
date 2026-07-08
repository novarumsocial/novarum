<script lang="ts">
  import { Send } from '@lucide/svelte';

  let content = $state('');
  let {
    placeholder = 'Send a message',
    onSend = () => {},
    onTyping = () => {},
  }: {
    placeholder?: string;
    onSend?: (content: string) => void;
    onTyping?: () => void;
  } = $props();

  function handleSend() {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSend(trimmed);
    content = '';
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (content.trim() || e.key.length === 1) onTyping();
  }
</script>

<div class="border-t border-border p-4">
  <div
    class="flex items-end gap-2 border border-border bg-background p-2 focus-within:border-primary/50"
  >
    <textarea
      bind:value={content}
      onkeydown={handleKeydown}
      {placeholder}
      rows="1"
      class="min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto break-words bg-transparent px-1 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
    ></textarea>
    <button
      onclick={handleSend}
      class="flex size-10 shrink-0 items-center justify-center bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!content.trim()}
      aria-label="Send message"
    >
      <Send class="size-4" />
    </button>
  </div>
</div>
