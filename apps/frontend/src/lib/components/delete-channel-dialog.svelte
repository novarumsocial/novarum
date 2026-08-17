<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { LoaderCircle, Trash2 } from '@lucide/svelte';
  import type { Channel } from '$lib/types/chat';

  let {
    open = $bindable(false),
    channel = null,
    onDelete,
  }: {
    open: boolean;
    channel?: Channel | null;
    onDelete?: (channel: Channel) => void;
  } = $props();

  let loading = $state(false);

  function handleDelete() {
    if (!channel) return;
    loading = true;
    onDelete?.(channel);
    // ponytail: fire-and-forget, parent closes via bind:open when done
    open = false;
    loading = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Delete Channel</Dialog.Title>
      <Dialog.Description>
        Are you sure you want to delete <strong>#{channel?.label || channel?.name || 'channel'}</strong>?
        This cannot be undone.
      </Dialog.Description>
    </Dialog.Header>

    <Dialog.Footer class="border-t border-border pt-3">
      <Button type="button" variant="ghost" class="mr-auto" onclick={() => (open = false)}>
        Cancel
      </Button>
      <Button type="button" variant="destructive" disabled={loading} onclick={handleDelete}>
        {#if loading}
          <LoaderCircle class="size-4 animate-spin" />
        {:else}
          <Trash2 class="size-4" />
        {/if}
        <span>Delete</span>
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
