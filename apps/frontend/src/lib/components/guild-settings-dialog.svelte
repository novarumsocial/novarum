<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { anchor } from '$lib/anchor.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import type { Server } from '$lib/types/chat';
  import Avatar from './avatar.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';

  let {
    open = $bindable(false),
    server,
  }: {
    open: boolean;
    server: Server;
  } = $props();

  let fileInput: HTMLInputElement;
  let cropFile = $state<File | null>(null);
  let cropOpen = $state(false);
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);

  function selectPicture(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      uploadError = 'Choose a GIF, JPEG, PNG, or WebP image.';
      return;
    }

    uploadError = null;
    if (file.type === 'image/gif') {
      void uploadPicture(file);
      return;
    }

    cropFile = file;
    cropOpen = true;
  }

  async function uploadPicture(blob: Blob) {
    uploading = true;
    uploadError = null;
    const type = blob.type === 'image/gif' ? 'image/gif' : 'image/png';
    const avatar = new File([blob], `guild-avatar.${type === 'image/gif' ? 'gif' : 'png'}`, {
      type,
    });

    try {
      const result = await anchor.client.guilds({ id: server.id }).avatar.post({ avatar });
      if (result.error || !result.data || 'error' in result.data) {
        uploadError = 'Could not upload the guild picture.';
        return;
      }

      chat.updateGuildAvatar(server.id, result.data.avatarUrl);
    } catch {
      uploadError = 'Could not upload the guild picture.';
    } finally {
      uploading = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Guild Settings</Dialog.Title>
      <Dialog.Description>Manage how your guild appears to members.</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-5">
      <div class="flex items-center gap-4">
        <Avatar src={server.avatarUrl} name={server.name} class="size-16 text-lg" />
        <div class="space-y-1.5">
          <p class="text-xs font-medium">Guild Picture</p>
          <p class="text-[11px] text-muted-foreground">GIF, JPEG, PNG, or WebP</p>
          <input
            bind:this={fileInput}
            type="file"
            accept="image/gif,image/jpeg,image/png,image/webp"
            class="hidden"
            onchange={selectPicture}
          />
          <Button
            variant="outline"
            size="xs"
            disabled={uploading}
            onclick={() => fileInput.click()}
          >
            {uploading ? 'Uploading...' : 'Change Picture'}
          </Button>
          {#if uploadError}
            <p class="text-[11px] text-destructive">{uploadError}</p>
          {/if}
        </div>
      </div>

      <div class="grid gap-1.5">
        <Label for="guild-name">Guild Name</Label>
        <Input id="guild-name" value={server.name} disabled />
      </div>

      <div class="grid gap-1.5">
        <Label for="guild-description">Description</Label>
        <textarea
          id="guild-description"
          class="min-h-20 w-full resize-none border border-input bg-transparent px-3 py-2 text-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled
          placeholder="Add a description for your guild"
          value={server.description ?? ''}
        ></textarea>
        <p class="text-[11px] text-muted-foreground">More guild settings are coming soon.</p>
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>

<AvatarCropDialog
  bind:open={cropOpen}
  file={cropFile}
  onCrop={uploadPicture}
  title="Crop Guild Picture"
  description="Adjust the image to fit your guild icon."
  actionLabel="Use Picture"
/>
