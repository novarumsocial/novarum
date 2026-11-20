<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Camera, Trash2 } from '@lucide/svelte';
  import { dms, dmDisplay, type DmEntry } from '$lib/dms.svelte';
  import { parseBotHandle } from '$lib/bots.svelte';
  import Avatar from './avatar.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';
  import BotBadge from './bot-badge.svelte';

  // only the group's owner opens this; the server checks it again anyway
  let { open = $bindable(false), group }: { open: boolean; group: DmEntry } = $props();

  let name = $state('');
  let message = $state<{ ok: boolean; text: string } | null>(null);
  let busy = $state(false);
  let botHandle = $state('');
  const bots = $derived(group.participants.filter((user) => user.isBot));

  $effect(() => {
    if (open) {
      name = group.name ?? '';
      message = null;
    }
  });

  async function run(action: () => Promise<string | null>, done: string) {
    busy = true;
    const error = await action();
    busy = false;
    message = error ? { ok: false, text: error } : { ok: true, text: done };
    return !error;
  }

  async function saveName(event: SubmitEvent) {
    event.preventDefault();
    await run(() => dms.rename(group.id, name.trim()), 'Saved.');
  }

  async function addBot(event: SubmitEvent) {
    event.preventDefault();
    const ref = parseBotHandle(botHandle);
    if (!ref) return void (message = { ok: false, text: 'Use a full handle, like @name:server.' });
    if (await run(() => dms.addBot(group.id, ref), `Added @${ref.username}:${ref.homeserver}.`))
      botHandle = '';
  }

  let fileInput: HTMLInputElement;
  let cropFile = $state<File | null>(null);
  let cropOpen = $state(false);

  function selectPicture(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      message = { ok: false, text: 'Choose a GIF, JPEG, PNG, or WebP image.' };
      return;
    }
    if (file.type === 'image/gif') return void uploadIcon(file);
    cropFile = file;
    cropOpen = true;
  }

  function uploadIcon(blob: Blob) {
    const type = blob.type === 'image/gif' ? 'image/gif' : 'image/png';
    const icon = new File([blob], `group-icon.${type === 'image/gif' ? 'gif' : 'png'}`, { type });
    return run(() => dms.uploadIcon(group.id, icon), 'Icon updated.');
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Group Settings</Dialog.Title>
      <Dialog.Description>Everyone in the group sees these changes.</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-5">
      <form class="flex items-end gap-4" onsubmit={saveName}>
        <div class="group relative size-16 shrink-0 overflow-hidden rounded-full">
          <Avatar src={group.iconUrl} name={dmDisplay(group).name} class="size-16 text-lg" />
          <input
            bind:this={fileInput}
            type="file"
            accept="image/gif,image/jpeg,image/png,image/webp"
            class="hidden"
            onchange={selectPicture}
          />
          <button
            type="button"
            aria-label="Change group icon"
            class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/55 disabled:cursor-wait"
            disabled={busy}
            onclick={() => fileInput.click()}
          >
            <Camera class="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </div>
        <div class="min-w-0 flex-1 space-y-1.5">
          <Label for="group-name">Group name</Label>
          <div class="flex gap-2">
            <Input
              id="group-name"
              bind:value={name}
              maxlength={100}
              placeholder="Members' names"
              autocomplete="off"
            />
            <Button type="submit" disabled={busy || name.trim() === (group.name ?? '')}>Save</Button
            >
          </div>
        </div>
      </form>

      <div class="space-y-2">
        <Label for="group-bot">Bots</Label>
        <form class="flex gap-2" onsubmit={addBot}>
          <Input
            id="group-bot"
            bind:value={botHandle}
            placeholder="@bot:homeserver"
            autocomplete="off"
            spellcheck="false"
          />
          <Button type="submit" disabled={busy || !botHandle.trim()}>Add</Button>
        </form>
        {#each bots as bot (bot.userId)}
          <div class="flex items-center gap-2 text-sm">
            <Avatar
              src={bot.avatarUrl}
              name={bot.displayName || bot.username}
              class="size-6 text-[10px]"
              bgColor={bot.avatarColor}
            />
            <span class="truncate">{bot.displayName || bot.username}</span>
            <BotBadge />
            <span class="flex-1"></span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove {bot.username}"
              disabled={busy}
              onclick={() => run(() => dms.kick(group.id, bot.userId), 'Bot removed.')}
            >
              <Trash2 class="size-4" />
            </Button>
          </div>
        {/each}
      </div>

      {#if message}
        <p
          class="text-xs"
          class:text-destructive={!message.ok}
          class:text-muted-foreground={message.ok}
        >
          {message.text}
        </p>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<AvatarCropDialog
  bind:open={cropOpen}
  file={cropFile}
  onCrop={uploadIcon}
  title="Crop Group Icon"
  description="Adjust the image to fit the group icon."
  actionLabel="Use Icon"
/>
