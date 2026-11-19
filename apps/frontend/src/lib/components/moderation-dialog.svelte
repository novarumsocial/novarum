<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { moderation } from '$lib/moderation.svelte';

  let reason = $state('');

  const pending = $derived(moderation.pending);
  const who = $derived(
    pending && pending.kind !== 'leave' ? pending.member.displayName || pending.member.username : ''
  );
  const copy = $derived.by(() => {
    if (!pending) return { title: '', description: '', action: '' };
    if (pending.kind === 'leave') {
      return {
        title: `Leave ${pending.server.name}?`,
        description: "You'll need a new invite to join again.",
        action: 'Leave server',
      };
    }
    if (pending.kind === 'kick') {
      return {
        title: `Kick ${who}?`,
        description: `${who} will be removed from ${pending.server.name}. They can join again with an invite.`,
        action: 'Kick',
      };
    }
    return {
      title: `Ban ${who}?`,
      description: `${who} will be removed from ${pending.server.name} and can't join again until you lift the ban.`,
      action: 'Ban',
    };
  });

  function onOpenChange(open: boolean) {
    if (open) return;
    moderation.pending = null;
    reason = '';
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await moderation.confirm(reason.trim());
    if (!moderation.pending) reason = '';
  }
</script>

<Dialog.Root open={!!pending} {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{copy.title}</Dialog.Title>
      <Dialog.Description>{copy.description}</Dialog.Description>
    </Dialog.Header>

    <form class="space-y-4" onsubmit={submit}>
      {#if pending?.kind === 'ban'}
        <div class="grid gap-1.5">
          <Label for="ban-reason"
            >Reason <span class="text-muted-foreground">(optional)</span></Label
          >
          <Textarea
            id="ban-reason"
            bind:value={reason}
            maxlength={512}
            placeholder="Only moderators of this server can see it"
            class="min-h-20 resize-none"
          />
        </div>
      {/if}

      {#if moderation.error}
        <p class="text-xs text-destructive" role="alert">{moderation.error}</p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" variant="destructive" disabled={moderation.busy}>
          {copy.action}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
