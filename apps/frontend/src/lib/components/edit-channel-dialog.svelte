<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Hash, LoaderCircle, Pencil, Volume2 } from '@lucide/svelte';
  import type { Channel } from '$lib/types/chat';

  let {
    open = $bindable(false),
    channel = null,
    onSave,
  }: {
    open: boolean;
    channel?: Channel | null;
    onSave?: (channel: Channel, name: string) => void;
  } = $props();

  let name = $state('');
  let loading = $state(false);

  // ponytail: sync name on open instead of derived — dialog is always freshly opened
  $effect(() => {
    if (open && channel) {
      name = channel.label || channel.name;
    }
  });

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!channel || !name.trim()) return;

    loading = true;
    onSave?.(channel, name.trim());
    // ponytail: fire-and-forget, parent closes via bind:open when done
    open = false;
    loading = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Edit Channel</Dialog.Title>
      <Dialog.Description
        >Rename #{channel?.label || channel?.name || 'channel'}.</Dialog.Description
      >
    </Dialog.Header>

    <form method="POST" class="space-y-4" onsubmit={handleSubmit}>
      <div class="grid gap-1.5">
        <label for="edit-channel-name" class="text-xs font-medium text-foreground">
          Channel Name
        </label>
        <div class="relative">
          {#if channel?.type === 'VOICE'}
            <Volume2
              class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
          {:else}
            <Hash
              class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
          {/if}
          <Input
            id="edit-channel-name"
            bind:value={name}
            class="pl-8"
            maxlength={32}
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </div>

      <Dialog.Footer class="border-t border-border pt-3">
        <Button type="button" variant="ghost" class="mr-auto" onclick={() => (open = false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={loading || !name.trim()}>
          {#if loading}
            <LoaderCircle class="size-4 animate-spin" />
          {:else}
            <Pencil class="size-4" />
          {/if}
          <span>Save</span>
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
