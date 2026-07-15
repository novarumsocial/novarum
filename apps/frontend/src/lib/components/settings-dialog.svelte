<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { User, Palette, Bell, Volume2, LogOut } from '@lucide/svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { goto } from '$app/navigation';
  import { useSession } from '$lib/session.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';
  import Avatar from './avatar.svelte';

  let { open = $bindable(false) }: { open: boolean } = $props();

  const session = useSession();
  let displayName = $state('');
  let email = $state('');
  let fileInput: HTMLInputElement;
  let cropFile = $state<File | null>(null);
  let cropOpen = $state(false);
  let avatarLoading = $state(false);
  let avatarError = $state<string | null>(null);
  let pushNotifications = $state(true);
  let messagePreview = $state(true);
  let mentionSound = $state(true);
  let showOnlineStatus = $state(true);

  let logoutLoading = $state(false);

  $effect(() => {
    if (!session.user) return;
    displayName = session.user.displayName ?? '';
    email = session.user.email ?? '';
  });

  function selectAvatar(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      avatarError = 'Choose a JPEG, PNG, or WebP image.';
      return;
    }

    avatarError = null;
    cropFile = file;
    cropOpen = true;
  }

  async function uploadAvatar(blob: Blob) {
    avatarLoading = true;
    avatarError = null;
    const avatar = new File([blob], 'avatar.png', { type: 'image/png' });

    try {
      const result = await anchor.client.user.avatar.post({ avatar });
      if (result.error || !result.data || 'error' in result.data) {
        avatarError = 'Could not upload your avatar.';
        return;
      }
      await session.refresh();
    } catch {
      avatarError = 'Could not upload your avatar.';
    } finally {
      avatarLoading = false;
    }
  }

  async function logout() {
    logoutLoading = true;
    await anchor.client.auth.logout.post();
    const me = await anchor.client.auth.me.get();
    if (!me.data) {
      await goto('/login');
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>User Settings</Dialog.Title>
      <Dialog.Description>Manage your account, appearance, and preferences.</Dialog.Description>
    </Dialog.Header>

    <Tabs.Root
      value="account"
      orientation="vertical"
      class="flex flex-col gap-4 sm:min-h-[360px] sm:flex-row sm:gap-0"
    >
      <div
        class="flex min-w-0 shrink-0 flex-col gap-2 sm:w-44 sm:border-r sm:border-border sm:pr-2"
      >
        <Tabs.List
          class="flex h-auto w-full items-stretch justify-start gap-0.5 overflow-x-auto bg-transparent p-0 sm:flex-col"
        >
          <Tabs.Trigger
            value="account"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <User class="size-3.5" />
            Account
          </Tabs.Trigger>

          <Tabs.Trigger
            value="appearance"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Palette class="size-3.5" />
            Appearance
          </Tabs.Trigger>

          <Tabs.Trigger
            value="notifications"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Bell class="size-3.5" />
            Notifications
          </Tabs.Trigger>

          <Tabs.Trigger
            value="voice"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Volume2 class="size-3.5" />
            Voice & Audio
          </Tabs.Trigger>
        </Tabs.List>

        <Button
          variant="destructive"
          size="sm"
          class="w-full rounded-none sm:mt-auto"
          disabled={logoutLoading}
          onclick={logout}
        >
          <LogOut class="size-3.5" />
          Logout
        </Button>
      </div>

      <div class="min-w-0 flex-1 sm:pl-4">
        <Tabs.Content value="account" class="space-y-4">
          <div class="grid gap-3">
            <div class="flex items-center gap-4">
              <Avatar
                src={session.user?.avatarUrl}
                name={session.user?.displayName || session.user?.username || '?'}
                class="size-14 text-lg"
              />
              <div class="space-y-1">
                <p class="text-xs font-medium">Avatar</p>
                <p class="text-[11px] text-muted-foreground">
                  Upload a photo to personalize your profile
                </p>
                <input
                  bind:this={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  class="hidden"
                  onchange={selectAvatar}
                />
                <Button
                  variant="outline"
                  size="xs"
                  disabled={avatarLoading}
                  onclick={() => fileInput.click()}
                >
                  {avatarLoading ? 'Uploading...' : 'Change Avatar'}
                </Button>
                {#if avatarError}
                  <p class="text-[11px] text-destructive">{avatarError}</p>
                {/if}
              </div>
            </div>
            <div class="grid gap-1.5">
              <Label for="display-name">Display Name</Label>
              <Input id="display-name" bind:value={displayName} />
            </div>
            <div class="grid gap-1.5">
              <Label for="email">Email</Label>
              <Input id="email" type="email" bind:value={email} />
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="appearance" class="space-y-4">
          <div class="grid gap-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Dark Mode</p>
                <p class="text-[11px] text-muted-foreground">Currently enabled</p>
              </div>
              <Switch checked disabled />
            </div>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Compact Mode</p>
                <p class="text-[11px] text-muted-foreground">Reduce spacing between messages</p>
              </div>
              <Switch />
            </div>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Show Member List</p>
                <p class="text-[11px] text-muted-foreground">Display member sidebar in channels</p>
              </div>
              <Switch checked />
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="notifications" class="space-y-4">
          <div class="grid gap-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Push Notifications</p>
                <p class="text-[11px] text-muted-foreground">
                  Receive push notifications for all activity
                </p>
              </div>
              <Switch bind:checked={pushNotifications} />
            </div>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Message Preview</p>
                <p class="text-[11px] text-muted-foreground">
                  Show message content in notifications
                </p>
              </div>
              <Switch bind:checked={messagePreview} />
            </div>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Mention Sound</p>
                <p class="text-[11px] text-muted-foreground">
                  Play a sound when someone mentions you
                </p>
              </div>
              <Switch bind:checked={mentionSound} />
            </div>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Online Status</p>
                <p class="text-[11px] text-muted-foreground">Show when you're online to others</p>
              </div>
              <Switch bind:checked={showOnlineStatus} />
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="voice" class="space-y-4">
          <div class="grid gap-3">
            <div class="grid gap-1.5">
              <Label for="input-device">Input Device</Label>
              <select
                id="input-device"
                class="flex h-8 w-full rounded-none border border-border bg-background px-2 text-xs text-foreground"
              >
                <option>Default Microphone</option>
                <option>Built-in Microphone</option>
                <option>USB Headset</option>
              </select>
            </div>
            <div class="grid gap-1.5">
              <Label for="output-device">Output Device</Label>
              <select
                id="output-device"
                class="flex h-8 w-full rounded-none border border-border bg-background px-2 text-xs text-foreground"
              >
                <option>Default Speaker</option>
                <option>Built-in Speakers</option>
                <option>USB Headset</option>
              </select>
            </div>
            <div class="grid gap-1.5">
              <Label for="input-volume">Input Volume</Label>
              <input
                id="input-volume"
                type="range"
                min="0"
                max="100"
                value="80"
                class="h-1.5 w-full cursor-pointer appearance-none rounded-none bg-border accent-primary"
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="output-volume">Output Volume</Label>
              <input
                id="output-volume"
                type="range"
                min="0"
                max="100"
                value="100"
                class="h-1.5 w-full cursor-pointer appearance-none rounded-none bg-border accent-primary"
              />
            </div>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Echo Cancellation</p>
                <p class="text-[11px] text-muted-foreground">Automatically suppress echo</p>
              </div>
              <Switch checked />
            </div>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-xs font-medium">Noise Suppression</p>
                <p class="text-[11px] text-muted-foreground">Reduce background noise</p>
              </div>
              <Switch checked />
            </div>
          </div>
        </Tabs.Content>
      </div>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>

<AvatarCropDialog bind:open={cropOpen} file={cropFile} onCrop={uploadAvatar} />
