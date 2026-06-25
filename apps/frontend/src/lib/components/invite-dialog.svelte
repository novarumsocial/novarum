<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Check, Copy, RefreshCw } from '@lucide/svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { chat } from '$lib/chat-state.svelte';
  import { anchor } from '$lib/anchor.svelte';

  let {
    open = $bindable(false),
    guildId = $bindable(''),
  }: {
    open: boolean;
    guildId: string;
  } = $props();

  let code = $state('');
  let copied = $state(false);

  const inviteUrl = $derived(
    `${window.location.origin}/i/$${code.toLowerCase()}@${anchor.homeServer}`
  );

  $effect(() => {
    if (open && code === '') {
      fetchInvite();
    }
  });

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl);
    copied = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    copied = false;
  }

  async function fetchInvite() {
    const invite = await chat.createInvite(guildId);
    if (invite) {
      code = invite.invite.code;
    }
  }

  async function regenerateInvite() {
    copied = false;
    await fetchInvite();
  }

  function handleOpenChange() {
    if (!open) {
      copied = false;
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Invite People</Dialog.Title>
      <Dialog.Description>
        Share this link to let people join the server. It expires after 24 hours or when
        regenerated.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      <div class="grid gap-1.5">
        <label for="invite-link" class="text-xs font-medium text-foreground">Invite Link</label>
        <div class="flex gap-2">
          <Input id="invite-link" value={inviteUrl} readonly class="font-mono text-xs" />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Copy invite link"
            onclick={copyInvite}
          >
            {#if copied}
              <Check class="size-4" />
            {:else}
              <Copy class="size-4" />
            {/if}
          </Button>
        </div>
      </div>

      <Dialog.Footer class="border-t border-border pt-3">
        <div class="flex gap-2">
          <Button type="button" variant="outline" onclick={regenerateInvite}>
            <RefreshCw class="size-4" />
            <span>Regenerate</span>
          </Button>
          <Button type="button" onclick={copyInvite}>
            {#if copied}
              <Check class="size-4" />
              <span>Copied</span>
            {:else}
              <Copy class="size-4" />
              <span>Copy Invite</span>
            {/if}
          </Button>
        </div>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>
