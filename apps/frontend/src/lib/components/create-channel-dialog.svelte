<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Hash, LoaderCircle, Plus, Volume2 } from '@lucide/svelte';
  import type { Channel } from '$lib/types/chat';
  import { cn } from '$lib/utils';

  let {
    open = $bindable(false),
    categoryLabel = 'Text Channels',
    onCreate,
  }: {
    open: boolean;
    categoryLabel?: string;
    onCreate?: (channel: Channel) => void;
  } = $props();

  let name = $state('');
  let type = $state<Channel['type']>('TEXT');
  let loading = $state(false);
  let error = $state('');
  const resolvedCategoryLabel = $derived(categoryLabel ?? 'Text Channels');

  function channelSlug(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-\s]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 32);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const trimmed = channelSlug(name);

    if (!trimmed || trimmed.length < 2 || trimmed.length > 32) {
      error = 'Channel name must be 2-32 letters, numbers, spaces, or dashes.';
      return;
    }

    loading = true;
    error = '';

    onCreate?.({
      id: `chn-${Date.now()}`,
      name: trimmed,
      unread: false,
      mention: 0,
      type,
    });

    open = false;
    loading = false;
    name = '';
    type = 'TEXT';
  }

  function handleOpenChange() {
    if (!open) {
      name = '';
      type = 'TEXT';
      error = '';
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Create Channel</Dialog.Title>
      <Dialog.Description>
        Add a channel to {resolvedCategoryLabel}.
      </Dialog.Description>
    </Dialog.Header>

    <form method="POST" class="space-y-4" onsubmit={handleSubmit}>
      <div class="grid gap-1.5">
        <label for="channel-name" class="text-xs font-medium text-foreground">
          Channel Name
        </label>
        <div class="relative">
          <Hash class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="channel-name"
            bind:value={name}
            placeholder="new-channel"
            class="pl-8"
            maxlength={32}
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </div>

      <div class="grid gap-2">
        <span class="text-xs font-medium text-foreground">Channel Type</span>
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            class={cn(
              'flex items-center gap-2 border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
              type === 'TEXT' && 'border-primary bg-primary/10',
            )}
            onclick={() => (type = 'TEXT')}
          >
            <Hash class="size-4 text-muted-foreground" />
            Text
          </button>
          <button
            type="button"
            class={cn(
              'flex items-center gap-2 border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
              type === 'VOICE' && 'border-primary bg-primary/10',
            )}
            onclick={() => (type = 'VOICE')}
          >
            <Volume2 class="size-4 text-muted-foreground" />
            Voice
          </button>
        </div>
      </div>

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}

      <Dialog.Footer class="border-t border-border pt-3">
        <Button type="button" variant="ghost" onclick={() => (open = false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={loading || !name.trim()}>
          {#if loading}
            <LoaderCircle class="size-4 animate-spin" />
            <span>Creating...</span>
          {:else}
            <Plus class="size-4" />
            <span>Create Channel</span>
          {/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
