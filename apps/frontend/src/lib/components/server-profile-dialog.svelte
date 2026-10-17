<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { Camera } from '@lucide/svelte';
  import type { PublicUser } from 'anchor/public-user';
  import { anchor } from '$lib/anchor.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { useSession } from '$lib/session.svelte';
  import { serverProfileDialog, settings } from '$lib/settings.svelte';
  import Avatar from './avatar.svelte';
  import AnimatedImage from './animated-image.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';

  type Picture = 'avatar' | 'banner';
  type Profile = {
    displayName: string | null;
    avatarUrl: string | null;
    bannerUrl: string | null;
    about: string | null;
  };

  const session = useSession();
  const server = $derived(chat.servers.find((item) => item.id === serverProfileDialog.guildId));

  let profile = $state<Profile | null>(null);
  let displayName = $state('');
  let about = $state('');
  let saving = $state(false);
  let uploading = $state<Picture | null>(null);
  let error = $state<string | null>(null);
  let avatarInput: HTMLInputElement;
  let bannerInput: HTMLInputElement;
  let cropFile = $state<File | null>(null);
  let cropTarget = $state<Picture>('avatar');
  let cropOpen = $state(false);

  // how the guild sees you: anything left empty falls back to your own profile
  const avatarUrl = $derived(profile?.avatarUrl || session.user?.avatarUrl);
  const bannerUrl = $derived(profile?.bannerUrl || session.user?.bannerUrl);
  const name = $derived(
    displayName.trim() || session.user?.displayName || session.user?.username || '?'
  );
  const dirty = $derived(
    !!profile &&
      ((displayName.trim() || null) !== profile.displayName ||
        (about.trim() || null) !== profile.about)
  );

  $effect(() => {
    const guildId = serverProfileDialog.guildId;
    profile = null;
    error = null;
    if (guildId) void load(guildId);
  });

  async function load(guildId: string) {
    const result = await anchor.client.guilds({ id: guildId }).profile.get();
    if (serverProfileDialog.guildId !== guildId) return;
    if (result.error || !result.data) {
      error = 'Could not load your server profile.';
      return;
    }

    const loaded: Profile = result.data.profile;
    profile = loaded;
    displayName = loaded.displayName ?? '';
    about = loaded.about ?? '';
  }

  async function update(
    request: Promise<{ data: { profile: Profile; user: PublicUser } | null; error: unknown }>,
    failure: string
  ) {
    const guildId = serverProfileDialog.guildId;
    error = null;
    try {
      const result = await request;
      if (result.error || !result.data || !guildId) {
        error = failure;
        return;
      }
      profile = result.data.profile;
      chat.updateMemberProfile(guildId, result.data.user);
    } catch {
      error = failure;
    }
  }

  function selectPicture(event: Event, target: Picture) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      error = 'Choose a GIF, JPEG, PNG, or WebP image.';
      return;
    }

    if (file.type === 'image/gif') {
      void uploadPicture(file, target);
      return;
    }

    cropTarget = target;
    cropFile = file;
    cropOpen = true;
  }

  async function uploadPicture(blob: Blob, target: Picture) {
    if (!server) return;
    const type = blob.type === 'image/gif' ? 'image/gif' : 'image/png';
    const picture = new File([blob], `${target}.${type === 'image/gif' ? 'gif' : 'png'}`, { type });

    uploading = target;
    await update(
      anchor.client.guilds({ id: server.id }).profile({ kind: target }).post({ picture }),
      `Could not upload your server ${target}.`
    );
    uploading = null;
  }

  function removePicture(target: Picture) {
    if (!server) return;
    void update(
      anchor.client
        .guilds({ id: server.id })
        .profile.patch(target === 'avatar' ? { avatarUrl: null } : { bannerUrl: null }),
      `Could not remove your server ${target}.`
    );
  }

  async function save() {
    if (!server) return;
    saving = true;
    await update(
      anchor.client.guilds({ id: server.id }).profile.patch({
        displayName: displayName.trim() || null,
        about: about.trim() || null,
      }),
      'Could not save your server profile.'
    );
    saving = false;
  }
</script>

<Dialog.Root
  open={!!server}
  onOpenChange={(open) => {
    if (!open) serverProfileDialog.guildId = null;
  }}
>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Server Profile</Dialog.Title>
      <Dialog.Description>
        How you appear in {server?.name ?? 'this server'}. Anything left empty uses your own
        profile.
      </Dialog.Description>
    </Dialog.Header>

    <section class="overflow-hidden bg-card">
      <div
        class="group relative aspect-[3/1] overflow-hidden"
        style:background-color={session.user?.avatarColor}
      >
        {#if bannerUrl}
          <AnimatedImage
            src={bannerUrl}
            alt="Server banner"
            class="size-full"
            focused={false}
            fit="cover"
          />
        {/if}
        <input
          bind:this={bannerInput}
          type="file"
          accept="image/gif,image/jpeg,image/png,image/webp"
          class="hidden"
          onchange={(event) => selectPicture(event, 'banner')}
        />
        <button
          type="button"
          aria-label="Change server banner"
          class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/45 focus-visible:bg-black/45 focus-visible:outline-none disabled:cursor-wait"
          disabled={!profile || uploading !== null}
          onclick={() => bannerInput.click()}
        >
          <span
            class="flex items-center gap-2 text-xs font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            class:opacity-100={uploading === 'banner'}
          >
            <Camera class="size-4" />
            {uploading === 'banner' ? 'Uploading…' : 'Change banner'}
          </span>
        </button>
      </div>

      <div class="flex items-end gap-4 px-4 pb-4">
        <input
          bind:this={avatarInput}
          type="file"
          accept="image/gif,image/jpeg,image/png,image/webp"
          class="hidden"
          onchange={(event) => selectPicture(event, 'avatar')}
        />
        <div
          class="group relative -mt-8 size-16 shrink-0 overflow-hidden border-4 border-card"
          class:rounded-full={settings.value.circleIcons}
          style:background-color={session.user?.avatarColor}
        >
          <Avatar src={avatarUrl} {name} class="size-full bg-transparent! text-xl text-white!" />
          <button
            type="button"
            aria-label="Change server avatar"
            class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/55 focus-visible:bg-black/55 focus-visible:outline-none disabled:cursor-wait"
            disabled={!profile || uploading !== null}
            onclick={() => avatarInput.click()}
          >
            <Camera
              class="size-5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            />
          </button>
        </div>
        <div class="min-w-0 flex-1 pt-3">
          <p class="truncate text-base font-semibold">{name}</p>
          <p class="truncate text-xs text-muted-foreground">{session.user?.handle}</p>
        </div>
      </div>
    </section>

    {#if profile?.avatarUrl || profile?.bannerUrl}
      <div class="flex flex-wrap gap-2">
        {#if profile.avatarUrl}
          <Button variant="outline" size="sm" onclick={() => removePicture('avatar')}>
            Remove server avatar
          </Button>
        {/if}
        {#if profile.bannerUrl}
          <Button variant="outline" size="sm" onclick={() => removePicture('banner')}>
            Remove server banner
          </Button>
        {/if}
      </div>
    {/if}

    <div class="grid gap-1.5">
      <Label for="server-display-name">Display name</Label>
      <Input
        id="server-display-name"
        bind:value={displayName}
        maxlength={64}
        disabled={!profile}
        placeholder={session.user?.displayName || session.user?.username}
      />
    </div>

    <div class="grid gap-1.5">
      <Label for="server-about">About me</Label>
      <Textarea
        id="server-about"
        bind:value={about}
        maxlength={512}
        rows={3}
        disabled={!profile}
        class="resize-none"
        placeholder={session.user?.about || 'What should people here know about you?'}
      />
    </div>

    <Dialog.Footer class="items-center">
      {#if error}
        <p class="mr-auto text-xs text-destructive">{error}</p>
      {/if}
      <Button disabled={!dirty || saving} onclick={save}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<AvatarCropDialog
  bind:open={cropOpen}
  file={cropFile}
  onCrop={(blob) => uploadPicture(blob, cropTarget)}
  title={cropTarget === 'banner' ? 'Crop Server Banner' : 'Crop Server Avatar'}
  description="Adjust the image to fit your server profile."
  actionLabel={cropTarget === 'banner' ? 'Use Banner' : 'Use Avatar'}
  outputWidth={cropTarget === 'banner' ? 960 : 512}
  outputHeight={cropTarget === 'banner' ? 320 : 512}
/>
