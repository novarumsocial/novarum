<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Hash, LoaderCircle, Plus } from '@lucide/svelte';
  import type { Server } from '$lib/types/chat';

  let {
    open = $bindable(false),
    onCreate,
  }: {
    open: boolean;
    onCreate?: (server: Server) => void;
  } = $props();

  let name = $state('');
  let description = $state('');
  let loading = $state(false);
  let error = $state('');

  function initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 32) {
      error = 'Server name must be 2–32 characters.';
      return;
    }
    loading = true;
    error = '';

    const server: Server = {
      id: `srv-${Date.now()}`,
      name: trimmed,
      initials: initials(trimmed),
      down: false,
    };

    onCreate?.(server);
    open = false;
    loading = false;
    name = '';
    description = '';
  }

  function handleOpenChange() {
    if (!open) {
      name = '';
      description = '';
      error = '';
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Create Server</Dialog.Title>
      <Dialog.Description>Give your server a name and upload a picture.</Dialog.Description>
    </Dialog.Header>

    <form method="POST" class="space-y-4" onsubmit={handleSubmit}>
      <div class="flex flex-col items-center gap-3">
        <div
          class="flex size-16 items-center justify-center text-lg font-bold text-white bg-primary"
        >
          {initials(name) || 'N'}
        </div>

        <div class="grid w-full gap-1.5">
          <label for="server-name" class="text-xs font-medium text-foreground"> Server Name </label>
          <div class="relative">
            <Hash
              class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="server-name"
              bind:value={name}
              placeholder="My Server"
              class="pl-8"
              maxlength={32}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
        </div>
      </div>

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}

      <Dialog.Footer class="border-t border-border pt-3">
        <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={loading || !name.trim()}>
          {#if loading}
            <LoaderCircle class="size-4 animate-spin" />
            <span>Creating…</span>
          {:else}
            <Plus class="size-4" />
            <span>Create Server</span>
          {/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
