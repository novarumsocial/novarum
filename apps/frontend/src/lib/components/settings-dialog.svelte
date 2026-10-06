<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import type { LaunchPrefs, UpdateCheck } from '$lib/electron-api';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as RadioGroup from '$lib/components/ui/radio-group';
  import {
    User,
    Palette,
    Bell,
    Volume2,
    LogOut,
    Camera,
    Languages,
    ShieldCheck,
    Smartphone,
    Copy,
    Check,
    LoaderCircle,
    Mail,
    Trash2,
    Monitor,
    RefreshCw,
  } from '@lucide/svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { goto } from '$app/navigation';
  import { getErrorMessage, useSession } from '$lib/session.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';
  import Avatar from './avatar.svelte';
  import AnimatedImage from './animated-image.svelte';
  import { settings, type TimeFormat } from '$lib/settings.svelte';
  import { VENMIC_DEVICE_LABEL, type Voice } from '$lib/voice.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import {
    getNotificationPermission,
    notificationSound,
    notificationsSupported,
    requestNotificationPermission,
  } from '$lib/notifications';
  import { disablePush, enablePush, pushAvailable } from '$lib/push';
  import { notificationSettings } from '$lib/notification-settings.svelte';
  import { onMount } from 'svelte';
  import { getAnchorInfo } from '$lib/api';
  import * as ColorPicker from '$lib/components/ui/color-picker/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import QRCode from 'qrcode';
  import { cn } from '$lib/utils';
  import SettingsGroup from './settings-group.svelte';
  import SettingsRow from './settings-row.svelte';

  let { open = $bindable(false), voice }: { open: boolean; voice: Voice } = $props();

  const session = useSession();
  let displayName = $state('');
  let email = $state('');
  let about = $state('');
  let avatarInput: HTMLInputElement;
  let bannerInput: HTMLInputElement;
  let selectedAvatarColor = $state(session.user?.avatarColor ?? '#005f78');
  let savedAvatarColor = $state(session.user?.avatarColor ?? '#005f78');
  let avatarColorOpen = $state(false);
  let speakingRingOpen = $state(false);
  let avatarColorLoading = $state(false);
  let avatarColorError = $state<string | null>(null);
  let selectedSpeakingRing = $state(session.user?.speakingRingColor ?? '#00d492');
  let savedSpeakingRing = $state(session.user?.speakingRingColor ?? '#00d492');
  let cropFile = $state<File | null>(null);
  let cropTarget = $state<'avatar' | 'banner'>('avatar');
  let cropOpen = $state(false);
  let mediaLoading = $state<'avatar' | 'banner' | null>(null);
  let mediaError = $state<string | null>(null);
  let aboutLoading = $state(false);
  let aboutError = $state<string | null>(null);
  let aboutSaved = $state(false);
  let logoutLoading = $state(false);
  let audioDevices = $state<{ input: MediaDeviceInfo[]; output: MediaDeviceInfo[] }>({
    input: [],
    output: [],
  });
  let audioDeviceError = $state<string | null>(null);
  let activeTab = $state('account');
  let mfaOptions = $state<('EMAIL' | 'TOTP')[]>([]);
  let mfaLoaded = $state(false);
  let mfaLoading = $state(false);
  let mfaError = $state<string | null>(null);
  let emailMfaLoading = $state(false);
  let totpState = $state<'idle' | 'setup' | 'enabled' | 'error'>('idle');
  let totpUri = $state('');
  let totpSecret = $state('');
  let totpQr = $state('');
  let totpCode = $state('');
  let totpLoading = $state(false);
  let totpError = $state<string | null>(null);
  let totpMfaLoading = $state(false);
  let secretCopied = $state(false);
  let totpDeleteLoading = $state(false);
  let confirmTotpDelete = $state(false);
  let confirmTotpTimer: ReturnType<typeof setTimeout> | undefined;

  let anchorVersion = $state<string | null>();
  const desktopVersion = await window.electron?.getVersion();
  let launchPrefs = $state(await window.electron?.getLaunchPrefs());
  const setLaunchPref = async (prefs: Partial<LaunchPrefs>) =>
    (launchPrefs = await window.electron?.setLaunchPrefs(prefs));
  let updateState = $state<'idle' | 'checking' | UpdateCheck['status']>('idle');
  let updateVersion = $state<string>();
  async function checkForUpdates() {
    updateState = 'checking';
    const result = await window.electron!.checkForUpdates();
    updateState = result.status;
    updateVersion = result.version;
  }
  const updateMessage = $derived(
    {
      idle: launchPrefs?.autoUpdate
        ? 'Novarum checks for updates every 30 minutes.'
        : 'Automatic checks are off.',
      checking: 'Checking for updates…',
      current: "You're on the latest version.",
      available: `Version ${updateVersion} is available.`,
      unsupported: 'Updates are only available in installed builds.',
      error: 'Could not check for updates. Try again later.',
    }[updateState]
  );
  const frontendVersion = __FRONTEND_VERSION__;
  const gitCommit = __GIT_COMMIT_HASH__.slice(0, 7);

  let css = $state(
    localStorage.getItem('quickcss') ||
      '/* type your custom CSS code here (e.g. a shadcn-ui layout.css) */'
  );

  $effect(() => {
    if (!open || anchorVersion !== undefined) return;

    anchorVersion = null;
    void getAnchorInfo(anchor.homeServer)
      .then((info) => (anchorVersion = info.version ?? null))
      .catch(() => {});
  });

  $effect(() => {
    if (!session.user) return;
    displayName = session.user.displayName ?? '';
    email = session.user.email ?? '';
    about = session.user.about ?? '';
    const avatarColor = session.user.avatarColor ?? '#6366F1';
    selectedAvatarColor = avatarColor;
    savedAvatarColor = avatarColor;
    const speakingRing = session.user.speakingRingColor ?? '#00d492';
    selectedSpeakingRing = speakingRing;
    savedSpeakingRing = speakingRing;
  });

  $effect(() => {
    if (!avatarColorOpen) selectedAvatarColor = savedAvatarColor;
  });

  $effect(() => {
    if (!speakingRingOpen) selectedSpeakingRing = savedSpeakingRing;
  });

  $effect(() => {
    if (open && activeTab === 'security' && !mfaLoaded && !mfaLoading && !mfaError) {
      void loadMfaStatus();
    }
  });

  $effect(() => {
    if (open) return;
    activeTab = 'account';
    mfaOptions = [];
    mfaLoaded = false;
    mfaError = null;
    totpState = 'idle';
    totpUri = '';
    totpSecret = '';
    totpQr = '';
    totpCode = '';
    totpError = null;
    secretCopied = false;
    totpMfaLoading = false;
    totpDeleteLoading = false;
    confirmTotpDelete = false;
    clearTimeout(confirmTotpTimer);
  });

  onMount(() => {
    void refreshAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refreshAudioDevices);
    };
  });

  function selectMedia(event: Event, target: 'avatar' | 'banner') {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      mediaError = 'Choose a GIF, JPEG, PNG, or WebP image.';
      return;
    }

    mediaError = null;
    if (file.type === 'image/gif') {
      void uploadMedia(file, target);
      return;
    }

    cropTarget = target;
    cropFile = file;
    cropOpen = true;
  }

  async function uploadMedia(blob: Blob, target: 'avatar' | 'banner') {
    mediaLoading = target;
    mediaError = null;
    const type = blob.type === 'image/gif' ? 'image/gif' : 'image/png';
    const file = new File([blob], `${target}.${type === 'image/gif' ? 'gif' : 'png'}`, { type });

    try {
      const result =
        target === 'avatar'
          ? await anchor.client.user.avatar.post({ avatar: file })
          : await anchor.client.user.banner.post({ banner: file });
      if (result.error || !result.data || 'error' in result.data) {
        mediaError = `Could not upload your ${target}.`;
        return;
      }
      chat.updateUserProfile(result.data.user.id, result.data.user);
      await session.refresh();
    } catch {
      mediaError = `Could not upload your ${target}.`;
    } finally {
      mediaLoading = null;
    }
  }

  async function saveAbout() {
    aboutLoading = true;
    aboutError = null;
    aboutSaved = false;

    try {
      const result = await anchor.client.user.about.post({ about: about.trim() || null });
      if (result.error || !result.data || 'error' in result.data) {
        aboutError = 'Could not update your about section.';
        return;
      }

      chat.updateUserProfile(result.data.user.id, result.data.user);
      await session.refresh();
      aboutSaved = true;
    } catch {
      aboutError = 'Could not update your about section.';
    } finally {
      aboutLoading = false;
    }
  }

  async function saveAvatarColor() {
    avatarColorLoading = true;
    avatarColorError = null;

    try {
      const result = await anchor.client.user.avatar.color.post({
        avatarColor: selectedAvatarColor.toUpperCase(),
        speakingRingColor: selectedSpeakingRing.toUpperCase(),
      });
      if (result.error || !result.data || 'error' in result.data) {
        avatarColorError = 'Could not update your avatar color.';
        return;
      }

      selectedAvatarColor = result.data.avatarColor;
      savedAvatarColor = result.data.avatarColor;
      selectedSpeakingRing = result.data.speakingRingColor;
      savedSpeakingRing = result.data.speakingRingColor;
      if (session.user) {
        chat.updateUserProfile(session.user.id, {
          avatarColor: result.data.avatarColor,
          speakingRingColor: result.data.speakingRingColor,
        });
      }
      await session.refresh();
      avatarColorOpen = false;
    } catch {
      avatarColorError = 'Could not update your avatar color.';
    } finally {
      avatarColorLoading = false;
    }
  }

  async function logout() {
    logoutLoading = true;
    await anchor.client.auth.logout.post();
    session.forget(anchor.homeServer);
    const me = await anchor.client.auth.me.get();
    if (!me.data) {
      window.location.href = '/login';
    }
  }

  async function loadMfaStatus() {
    mfaLoading = true;
    mfaError = null;

    try {
      const result = await anchor.client.auth.mfa.get();
      if (result.error || !result.data) {
        mfaError = getErrorMessage(result.error?.value, 'Could not load MFA settings.');
        return;
      }

      mfaOptions = result.data.mfaOptions;
      mfaLoaded = true;
      if (mfaOptions.includes('TOTP')) {
        totpState = 'enabled';
      } else {
        await loadTotpSetup();
      }
    } catch (error) {
      mfaError = getErrorMessage(error, 'Could not load MFA settings.');
    } finally {
      mfaLoading = false;
    }
  }

  async function toggleEmailMfa(enable: boolean) {
    emailMfaLoading = true;
    mfaError = null;

    try {
      const result = await anchor.client.auth.mfa.email.toggle.post({ enable });
      if (result.error) {
        mfaError = getErrorMessage(result.error.value, 'Could not update email MFA.');
        return;
      }

      mfaOptions = enable
        ? [...new Set([...mfaOptions, 'EMAIL' as const])]
        : mfaOptions.filter((option) => option !== 'EMAIL');
    } catch (error) {
      mfaError = getErrorMessage(error, 'Could not update email MFA.');
    } finally {
      emailMfaLoading = false;
    }
  }

  async function toggleTotpMfa(enable: boolean) {
    totpMfaLoading = true;
    mfaError = null;

    try {
      const result = await anchor.client.auth.mfa.totp.toggle.post({ enable });
      if (result.error) {
        mfaError = getErrorMessage(result.error.value, 'Could not update authenticator MFA.');
        return;
      }

      mfaOptions = enable
        ? [...new Set([...mfaOptions, 'TOTP' as const])]
        : mfaOptions.filter((option) => option !== 'TOTP');
    } catch (error) {
      mfaError = getErrorMessage(error, 'Could not update authenticator MFA.');
    } finally {
      totpMfaLoading = false;
    }
  }

  async function loadTotpSetup() {
    totpLoading = true;
    totpError = null;

    try {
      const result = await anchor.client.auth.mfa.totp.qr.get();
      if (result.error) {
        const message = getErrorMessage(result.error.value, 'Could not load MFA settings.');
        if (result.response.status === 400 && message.includes('already enabled')) {
          totpState = 'enabled';
          return;
        }
        totpError = message;
        totpState = 'error';
        return;
      }

      if (!result.data) {
        totpError = 'The server returned an invalid MFA setup.';
        totpState = 'error';
        return;
      }

      totpUri = result.data.uri;
      totpSecret = result.data.secret;
      totpQr = await QRCode.toDataURL(totpUri, {
        width: 224,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#111827', light: '#ffffff' },
      });
      totpState = 'setup';
    } catch (error) {
      totpError = getErrorMessage(error, 'Could not load MFA settings.');
      totpState = 'error';
    } finally {
      totpLoading = false;
    }
  }

  async function enableTotp(event: SubmitEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(totpCode)) {
      totpError = 'Enter the 6-digit code from your authenticator app.';
      return;
    }

    totpLoading = true;
    totpError = null;

    try {
      const result = await anchor.client.auth.mfa.totp.enable.post({
        secret: totpSecret,
        code: totpCode,
      });
      if (result.error) {
        totpError = getErrorMessage(result.error.value, 'Could not enable MFA.');
        return;
      }

      totpState = 'enabled';
      mfaOptions = [...new Set([...mfaOptions, 'TOTP' as const])];
      totpUri = '';
      totpSecret = '';
      totpQr = '';
      totpCode = '';
    } catch (error) {
      totpError = getErrorMessage(error, 'Could not enable MFA.');
    } finally {
      totpLoading = false;
    }
  }

  async function copyTotpSecret() {
    try {
      await navigator.clipboard.writeText(totpSecret);
      secretCopied = true;
      setTimeout(() => (secretCopied = false), 1500);
    } catch {
      totpError = 'Could not copy the setup key.';
    }
  }

  async function deleteTotp() {
    totpDeleteLoading = true;
    mfaError = null;

    try {
      const result = await anchor.client.auth.mfa.totp.delete();
      if (result.error) {
        mfaError = getErrorMessage(result.error.value, 'Could not remove authenticator MFA.');
        return;
      }

      mfaOptions = mfaOptions.filter((option) => option !== 'TOTP');
      totpState = 'idle';
      await loadTotpSetup();
    } catch (error) {
      mfaError = getErrorMessage(error, 'Could not remove authenticator MFA.');
    } finally {
      totpDeleteLoading = false;
    }
  }

  function requestDeleteTotp() {
    if (!confirmTotpDelete) {
      confirmTotpDelete = true;
      confirmTotpTimer = setTimeout(() => (confirmTotpDelete = false), 5000);
      return;
    }
    clearTimeout(confirmTotpTimer);
    confirmTotpDelete = false;
    void deleteTotp();
  }

  $effect(() => {
    let tag = document.getElementById('quickcss') as HTMLStyleElement;
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'quickcss';
      document.head.appendChild(tag);
    }
    tag.textContent = css;
    localStorage.setItem('quickcss', css);
  });

  let pushError = $state<string | null>(null);

  async function setPushNotifications(enabled: boolean) {
    pushError = null;
    if (!enabled) {
      settings.value.pushNotifications = false;
      void disablePush();
      void notificationSettings.savePreferences({ push: false });
      return;
    }

    // phones have no Notification api; their notifications come from the push service alone
    const canShow = notificationsSupported();
    if (!canShow && !pushAvailable()) {
      settings.value.pushNotifications = false;
      return;
    }

    const permission = await getNotificationPermission();
    const granted =
      !canShow || permission === 'granted' || (await requestNotificationPermission()) === 'granted';
    if (!granted) {
      settings.value.pushNotifications = false;
      return;
    }

    try {
      await enablePush();
    } catch (error) {
      pushError = error instanceof Error ? error.message : 'Could not set up push notifications';
      settings.value.pushNotifications = false;
      return;
    }

    settings.value.pushNotifications = true;
    void notificationSettings.savePreferences({ push: true });
    if (canShow) new Notification('Novarum notifications enabled');
  }

  // the server decides what a push contains, so it needs to know about this one too
  function setMessagePreview(enabled: boolean) {
    settings.value.messagePreview = enabled;
    void notificationSettings.savePreferences({ messagePreview: enabled });
  }

  async function refreshAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioDevices = {
        input: devices.filter(
          (device) =>
            device.kind === 'audioinput' &&
            device.deviceId !== 'default' &&
            device.label !== VENMIC_DEVICE_LABEL
        ),
        output: devices.filter(
          (device) => device.kind === 'audiooutput' && device.deviceId !== 'default'
        ),
      };
    } catch (error) {
      console.error('Error getting audio devices:', error);
    }
  }

  async function setAudioDevice(kind: 'input' | 'output', deviceId: string) {
    audioDeviceError = null;
    try {
      if (kind === 'input') await voice.setInputDevice(deviceId);
      else await voice.setOutputDevice(deviceId);
      await refreshAudioDevices();
    } catch {
      audioDeviceError =
        kind === 'input'
          ? 'Could not switch to that microphone.'
          : 'Could not switch to that output device. Your browser may not support audio routing.';
    }
  }

  const timeFormats = [
    { value: 'auto', label: 'Automatic', example: 'Follow your system settings' },
    { value: '12hr', label: '12-hour', example: 'Example: 3:30 PM' },
    { value: '24hr', label: '24-hour', example: 'Example: 15:30' },
  ];

  const pages = $derived([
    { id: 'account', group: 'You', title: 'Account', icon: User },
    { id: 'security', group: 'You', title: 'Privacy & security', icon: ShieldCheck },
    { id: 'appearance', group: 'App', title: 'Appearance', icon: Palette },
    { id: 'notifications', group: 'App', title: 'Notifications', icon: Bell },
    { id: 'voice', group: 'App', title: 'Voice & audio', icon: Volume2 },
    { id: 'langt', group: 'App', title: 'Language & time', icon: Languages },
    ...(launchPrefs
      ? [{ id: 'desktop', group: 'This computer', title: 'Desktop app', icon: Monitor }]
      : []),
  ]);
  // on phones the nav is a sideways strip, so keep the open page in view
  $effect(() => {
    document
      .querySelector(`[data-page="${activeTab}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  const navGroups = $derived(
    [...new Set(pages.map((p) => p.group))].map((label) => ({
      label,
      pages: pages.filter((p) => p.group === label),
    }))
  );

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'la', label: 'Latin' },
  ];
</script>

{#snippet head(title: string, description: string)}
  <header class="mb-8">
    <h2 class="text-2xl font-semibold tracking-tight">{title}</h2>
    <p class="mt-1 text-sm text-muted-foreground">{description}</p>
  </header>
{/snippet}

{#snippet colorButton(label: string, color: string)}
  <span class="sr-only">{label}</span>
  <span class="size-4 border border-black/15" style:background-color={color}></span>
  <span class="font-mono text-xs">{color.toUpperCase()}</span>
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Content
    class="top-0 left-0 h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-cols-1 gap-0 overflow-hidden bg-background p-0 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[calc(100dvh-1rem)] sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2"
  >
    <Dialog.Header class="sr-only">
      <Dialog.Title>Settings</Dialog.Title>
      <Dialog.Description>Manage your profile, privacy, and app preferences.</Dialog.Description>
    </Dialog.Header>

    <Tabs.Root
      bind:value={activeTab}
      style="--you: {savedAvatarColor}"
      orientation="vertical"
      class="flex h-dvh min-w-0 flex-col gap-0 sm:h-[min(680px,88vh)] sm:flex-row"
    >
      <nav
        class="flex min-w-0 shrink-0 flex-col gap-1 border-b bg-sidebar p-2 pr-12 sm:w-60 sm:pr-3 sm:gap-3 sm:border-r sm:border-b-0 sm:p-3"
      >
        <div class="hidden items-center gap-3 px-2 py-2 sm:flex">
          <div
            class="size-10 shrink-0 overflow-hidden"
            class:rounded-full={settings.value.circleIcons}
            style:background-color={savedAvatarColor}
          >
            <Avatar
              src={session.user?.avatarUrl}
              name={session.user?.displayName || session.user?.username || '?'}
              class="size-full bg-transparent! text-white!"
            />
          </div>
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">
              {session.user?.displayName || session.user?.username || 'You'}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              {session.user?.handle || `@${session.user?.username ?? 'you'}`}
            </p>
          </div>
        </div>

        <div
          class="flex gap-3 overflow-x-auto sm:flex-1 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto"
        >
          {#each navGroups as group (group.label)}
            <div class="flex shrink-0 flex-col gap-0.5">
              <p class="hidden px-2 pb-1 text-xs text-muted-foreground sm:block">{group.label}</p>
              <Tabs.List
                class="flex h-auto w-full flex-row! gap-0.5 bg-transparent p-0 sm:flex-col!"
              >
                {#each group.pages as page (page.id)}
                  <Tabs.Trigger
                    value={page.id}
                    data-page={page.id}
                    class="min-h-9 shrink-0 justify-start gap-2.5 border-0 px-2.5 py-1.5 text-muted-foreground hover:text-foreground data-active:bg-sidebar-accent! data-active:text-foreground data-active:shadow-[inset_0_-2px_0_var(--you)] sm:w-full sm:data-active:shadow-[inset_2px_0_0_var(--you)]"
                  >
                    <page.icon class="size-4" />
                    {page.title}
                  </Tabs.Trigger>
                {/each}
              </Tabs.List>
            </div>
          {/each}
        </div>

        <div class="hidden flex-col gap-0.5 px-2 text-[11px] text-muted-foreground sm:flex">
          <p>Frontend v{frontendVersion} · Anchor {anchorVersion ?? 'unknown'}</p>
          {#if desktopVersion}<p>Desktop v{desktopVersion}</p>{/if}
          <a
            href={`https://github.com/novarumsocial/novarum/commit/${gitCommit}`}
            class="w-fit font-mono underline">{gitCommit}</a
          >
        </div>
        <Button
          variant="destructive"
          class="hidden w-full sm:inline-flex"
          disabled={logoutLoading}
          onclick={logout}
        >
          <LogOut class="size-4" />
          Log out
        </Button>
      </nav>

      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-8">
        <div class="mx-auto max-w-xl">
          <Tabs.Content value="account" class="space-y-6 outline-none">
            {@render head('Account', 'How you appear to everyone on Novarum.')}

            <section class="overflow-hidden bg-card">
              <div
                class="group relative h-28 overflow-hidden sm:h-32"
                style:background={`linear-gradient(125deg, ${selectedAvatarColor}, color-mix(in srgb, ${selectedAvatarColor} 35%, var(--background)))`}
              >
                {#if session.user?.bannerUrl}
                  <AnimatedImage
                    src={session.user.bannerUrl}
                    alt="Profile banner"
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
                  onchange={(event) => selectMedia(event, 'banner')}
                />
                <button
                  type="button"
                  aria-label="Change profile banner"
                  class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/45 focus-visible:bg-black/45 focus-visible:outline-none disabled:cursor-wait"
                  disabled={mediaLoading !== null}
                  onclick={() => bannerInput.click()}
                >
                  <span
                    class="flex items-center gap-2 text-xs font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    class:opacity-100={mediaLoading === 'banner'}
                  >
                    <Camera class="size-4" />
                    {mediaLoading === 'banner' ? 'Uploading…' : 'Change banner'}
                  </span>
                </button>
              </div>

              <div class="flex items-end gap-4 px-4 pb-4">
                <input
                  bind:this={avatarInput}
                  type="file"
                  accept="image/gif,image/jpeg,image/png,image/webp"
                  class="hidden"
                  onchange={(event) => selectMedia(event, 'avatar')}
                />
                <div
                  class="group relative -mt-10 size-20 shrink-0 overflow-hidden border-4 border-card"
                  class:rounded-full={settings.value.circleIcons}
                  style:background-color={selectedAvatarColor}
                >
                  <Avatar
                    src={session.user?.avatarUrl}
                    name={session.user?.displayName || session.user?.username || '?'}
                    class="size-full bg-transparent! text-2xl text-white!"
                  />
                  <button
                    type="button"
                    aria-label="Change profile picture"
                    class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/55 focus-visible:bg-black/55 focus-visible:outline-none disabled:cursor-wait"
                    disabled={mediaLoading !== null}
                    onclick={() => avatarInput.click()}
                  >
                    <Camera
                      class="size-5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    />
                  </button>
                </div>
                <div class="min-w-0 flex-1 pt-3">
                  <p class="truncate text-base font-semibold">
                    {session.user?.displayName || session.user?.username || 'Your profile'}
                  </p>
                  <p class="truncate text-xs text-muted-foreground">
                    {session.user?.handle || `@${session.user?.username ?? 'you'}`}
                  </p>
                </div>
              </div>
              {#if mediaError}
                <p class="px-4 pb-3 text-xs text-destructive">{mediaError}</p>
              {/if}
            </section>

            <SettingsGroup title="About me">
              <div>
                <textarea
                  id="about"
                  bind:value={about}
                  maxlength="512"
                  rows="4"
                  placeholder="What should people know about you?"
                  class="block w-full resize-none bg-transparent px-4 py-3.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
                  oninput={() => (aboutSaved = false)}></textarea>
                <div class="flex items-center justify-between gap-3 px-4 pb-3">
                  <p class="text-xs text-destructive">
                    {aboutError ?? ''}
                    <span class="text-muted-foreground"
                      >{aboutError ? '' : `${about.length}/512`}</span
                    >
                  </p>
                  <Button size="sm" disabled={aboutLoading} onclick={saveAbout}>
                    {aboutLoading ? 'Saving…' : aboutSaved ? 'Saved' : 'Save about'}
                  </Button>
                </div>
              </div>
            </SettingsGroup>

            <SettingsGroup
              title="Colors"
              description="Used for your avatar and when you speak in voice."
            >
              <SettingsRow
                title="Avatar color"
                description="Shown behind your picture and on your banner."
              >
                <Popover.Root bind:open={avatarColorOpen}>
                  <Popover.Trigger>
                    {#snippet child({ props })}
                      <Button {...props} variant="outline" size="sm" class="gap-2">
                        {@render colorButton('Change avatar color', selectedAvatarColor)}
                      </Button>
                    {/snippet}
                  </Popover.Trigger>
                  <Popover.Content align="end" class="w-auto overflow-hidden p-0">
                    <ColorPicker.Root
                      bind:value={selectedAvatarColor}
                      formats={['hex']}
                      class="w-[min(350px,calc(100vw-3rem))] rounded-none border-0 shadow-none"
                    />
                    {@render colorActions(() => (avatarColorOpen = false))}
                  </Popover.Content>
                </Popover.Root>
              </SettingsRow>
              <SettingsRow
                title="Speaking ring"
                description="The outline around you while you talk."
              >
                <Popover.Root bind:open={speakingRingOpen}>
                  <Popover.Trigger>
                    {#snippet child({ props })}
                      <Button {...props} variant="outline" size="sm" class="gap-2">
                        {@render colorButton('Change speaking ring color', selectedSpeakingRing)}
                      </Button>
                    {/snippet}
                  </Popover.Trigger>
                  <Popover.Content align="end" class="w-auto overflow-hidden p-0">
                    <ColorPicker.Root
                      bind:value={selectedSpeakingRing}
                      formats={['hex']}
                      class="w-[min(350px,calc(100vw-3rem))] rounded-none border-0 shadow-none"
                    />
                    {@render colorActions(() => (speakingRingOpen = false))}
                  </Popover.Content>
                </Popover.Root>
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup title="Sign-in details">
              <SettingsRow title="Display name">
                <span class="block max-w-48 truncate text-sm text-muted-foreground"
                  >{displayName}</span
                >
              </SettingsRow>
              <SettingsRow title="Email address" description="Only visible to you.">
                <span class="block max-w-48 truncate text-sm text-muted-foreground">{email}</span>
              </SettingsRow>
            </SettingsGroup>

            <div class="sm:hidden">
              <SettingsGroup title="Session">
                <SettingsRow
                  title="Log out"
                  description="You'll need to sign in again on this device."
                >
                  <Button variant="destructive" size="sm" disabled={logoutLoading} onclick={logout}>
                    <LogOut class="size-3.5" />
                    Log out
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            </div>
          </Tabs.Content>

          <Tabs.Content value="security" class="space-y-6 outline-none">
            {@render head(
              'Privacy & security',
              'Protect your account and choose what others can see.'
            )}

            <SettingsGroup title="Privacy">
              <SettingsRow
                title="Show online status"
                description="Let people see when you're online."
                id="online-status"
              >
                <Switch id="online-status" bind:checked={settings.value.showOnlineStatus} />
              </SettingsRow>
            </SettingsGroup>

            {#if mfaLoading && !mfaLoaded}
              <LoaderCircle class="size-4 animate-spin text-muted-foreground" />
              <span class="text-xs text-muted-foreground">Checking MFA status...</span>
            {:else if !mfaLoaded}
              <div class="min-w-0">
                <p class="text-sm font-medium">MFA settings are unavailable</p>
                <p class="mt-1 text-xs text-destructive">
                  {mfaError ?? 'Could not load MFA settings.'}
                </p>
              </div>
              <Button variant="outline" size="xs" onclick={loadMfaStatus}>Try again</Button>
            {:else}
              <SettingsGroup
                title="Two-step verification"
                description="Ask for a second code when you sign in."
              >
                <div class="flex items-center justify-between gap-4 px-4 py-3">
                  <div class="flex min-w-0 items-start gap-3">
                    <div
                      class={cn(
                        'flex size-8 shrink-0 items-center justify-center',
                        mfaOptions.includes('EMAIL')
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      <Mail class="size-4" />
                    </div>
                    <div class="min-w-0">
                      <Label for="email-mfa" class="text-sm font-medium">Email codes</Label>
                      <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        A one-time code sent to your account email.
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="email-mfa"
                    checked={mfaOptions.includes('EMAIL')}
                    disabled={emailMfaLoading}
                    aria-label="Enable email MFA"
                    onCheckedChange={toggleEmailMfa}
                  />
                </div>

                {#if totpLoading && totpState === 'idle'}
                  <div class="flex min-h-20 items-center justify-center gap-2 px-4 py-4">
                    <LoaderCircle class="size-4 animate-spin text-muted-foreground" />
                    <span class="text-xs text-muted-foreground"
                      >Preparing authenticator setup...</span
                    >
                  </div>
                {:else if totpState === 'enabled'}
                  <div class="flex items-center justify-between gap-4 px-4 py-3">
                    <div class="flex min-w-0 items-start gap-3">
                      <div
                        class={cn(
                          'flex size-8 shrink-0 items-center justify-center',
                          mfaOptions.includes('TOTP')
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        <ShieldCheck class="size-4" />
                      </div>
                      <div class="min-w-0">
                        <p class="text-sm font-medium">Authenticator app</p>
                        <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          One-time codes from your authenticator app.
                        </p>
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-4">
                      <Button
                        variant="outline"
                        size="icon-xs"
                        class={confirmTotpDelete
                          ? 'border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground'
                          : ''}
                        disabled={totpMfaLoading || totpDeleteLoading}
                        onclick={requestDeleteTotp}
                      >
                        {#if totpDeleteLoading}
                          <LoaderCircle class="size-3.5 animate-spin" />
                        {:else if confirmTotpDelete}
                          <Trash2 class="size-3.5" /> ?
                        {:else}
                          <Trash2 class="size-3.5" />
                        {/if}
                      </Button>
                      <Switch
                        checked={mfaOptions.includes('TOTP')}
                        disabled={totpMfaLoading || totpDeleteLoading}
                        aria-label="Enable authenticator MFA"
                        onCheckedChange={toggleTotpMfa}
                      />
                    </div>
                  </div>
                {:else if totpState === 'setup'}
                  <div class="space-y-4 px-4 py-4">
                    <div class="flex items-center gap-2">
                      <Smartphone class="size-4" />
                      <p class="text-sm font-medium">Set up an authenticator app</p>
                    </div>

                    <div class="grid items-center gap-4 sm:grid-cols-[auto_1fr]">
                      <div class="mx-auto bg-white p-2 shadow-sm sm:mx-0">
                        <img
                          src={totpQr}
                          alt="Authenticator setup QR code"
                          class="size-40 not-hover:blur-xs transition not-hover:blur-none"
                        />
                      </div>

                      <div class="min-w-0 space-y-2">
                        <div>
                          <p class="text-xs font-medium">Can't scan it?</p>
                          <p class="text-[11px] text-muted-foreground">
                            Enter this setup key manually. Keep it private.
                          </p>
                        </div>
                        <div class="flex items-stretch border bg-muted/40">
                          <code
                            class="min-w-0 flex-1 break-all px-2.5 py-2 font-mono text-[11px] not-hover:blur-xs transition blur-none"
                          >
                            {totpSecret}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            class="h-auto border-l"
                            aria-label="Copy setup key"
                            onclick={copyTotpSecret}
                          >
                            {#if secretCopied}
                              <Check class="size-3.5" />
                            {:else}
                              <Copy class="size-3.5" />
                            {/if}
                          </Button>
                        </div>
                      </div>
                    </div>

                    <form class="space-y-2" onsubmit={enableTotp}>
                      <div class="grid gap-1.5">
                        <Label for="totp-code">Verification code</Label>
                        <div class="flex gap-2">
                          <Input
                            id="totp-code"
                            bind:value={totpCode}
                            inputmode="numeric"
                            autocomplete="one-time-code"
                            maxlength={6}
                            placeholder="000000"
                            class="h-9 font-mono text-base tracking-[0.3em]"
                            aria-invalid={Boolean(totpError)}
                            autofocus
                          />
                          <Button type="submit" class="h-9" disabled={totpLoading}>
                            {#if totpLoading}
                              <LoaderCircle class="size-4 animate-spin" />
                            {/if}
                            Enable MFA
                          </Button>
                        </div>
                      </div>
                      <p class="min-h-4 text-xs text-destructive" aria-live="polite">
                        {totpError ?? ''}
                      </p>
                    </form>
                  </div>
                {:else}
                  <div class="flex items-center justify-between gap-4 px-4 py-3">
                    <div class="min-w-0">
                      <p class="text-sm font-medium">Authenticator app</p>
                      <p class="mt-0.5 text-xs text-destructive">
                        {totpError ?? 'Could not prepare authenticator setup.'}
                      </p>
                    </div>
                    <Button variant="outline" size="xs" onclick={loadTotpSetup}>Try again</Button>
                  </div>
                {/if}

                {#if mfaError}
                  <p class="px-4 py-2 text-xs text-destructive" aria-live="polite">{mfaError}</p>
                {/if}
              </SettingsGroup>
            {/if}
          </Tabs.Content>

          <Tabs.Content value="appearance" class="space-y-6 outline-none">
            {@render head('Appearance', 'Make Novarum look the way you like.')}

            <SettingsGroup title="Theme">
              <SettingsRow
                title="Dark mode"
                description="Use the dark color scheme."
                id="dark-mode"
              >
                <Switch id="dark-mode" bind:checked={settings.value.darkMode} />
              </SettingsRow>
              <SettingsRow
                title="Round icons"
                description="Show avatars and server icons as circles instead of squares."
                id="circle-icons"
              >
                <Switch id="circle-icons" bind:checked={settings.value.circleIcons} />
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup title="Layout">
              <SettingsRow
                title="Show member list"
                description="Display the member sidebar in channels."
                id="member-list"
              >
                <Switch id="member-list" bind:checked={settings.value.showMemberList} />
              </SettingsRow>
              <SettingsRow
                title="Compact mode"
                description="Reduce spacing between messages. Coming soon."
                id="compact-mode"
              >
                <Switch id="compact-mode" bind:checked={settings.value.compactMode} disabled />
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup
              title="Custom CSS"
              description="Applied instantly and saved on this device."
            >
              <textarea
                bind:value={css}
                aria-label="Custom CSS"
                spellcheck="false"
                class="min-h-56 w-full resize-y bg-transparent p-4 font-mono text-xs outline-none"
              ></textarea>
            </SettingsGroup>
          </Tabs.Content>

          <Tabs.Content value="notifications" class="space-y-6 outline-none">
            {@render head('Notifications', 'Choose how Novarum gets your attention.')}

            <SettingsGroup title="Alerts">
              <SettingsRow
                title="Push notifications"
                description="Get notified about mentions and replies."
                id="push"
              >
                <Switch
                  id="push"
                  checked={settings.value.pushNotifications}
                  onCheckedChange={setPushNotifications}
                />
              </SettingsRow>
              <SettingsRow
                title="Message preview"
                description="Show the message text in notifications."
                id="preview"
              >
                <Switch
                  id="preview"
                  checked={settings.value.messagePreview}
                  onCheckedChange={setMessagePreview}
                />
              </SettingsRow>
              {#if pushError}
                <p class="px-4 py-2 text-xs text-destructive" aria-live="polite">{pushError}</p>
              {/if}
            </SettingsGroup>

            <SettingsGroup title="Sound">
              <SettingsRow
                title="Mention sound"
                description="Play a sound when someone mentions you."
                id="mention-sound"
              >
                <Switch id="mention-sound" bind:checked={settings.value.mentionSound} />
              </SettingsRow>
              <SettingsRow title="Volume" stacked id="notification-volume">
                <Slider
                  type="single"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.value.notificationVolume}
                  onValueCommit={(v) => {
                    settings.value.notificationVolume = v;
                    notificationSound();
                  }}
                />
              </SettingsRow>
            </SettingsGroup>
          </Tabs.Content>

          <Tabs.Content value="voice" class="space-y-6 outline-none">
            {@render head('Voice & audio', 'Pick your devices and how your voice is processed.')}

            <SettingsGroup title="Devices">
              <SettingsRow title="Microphone" stacked id="input-device">
                <Select.Root
                  type="single"
                  value={settings.value.voiceInputDeviceId}
                  onValueChange={(value) => setAudioDevice('input', value)}
                >
                  <Select.Trigger id="input-device" class="w-full">
                    {settings.value.voiceInputDeviceId === 'default'
                      ? 'Default microphone'
                      : (audioDevices.input.find(
                          (d) => d.deviceId === settings.value.voiceInputDeviceId
                        )?.label ?? 'Unknown microphone')}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="default">Default microphone</Select.Item>
                    {#each audioDevices.input as device, index}
                      <Select.Item value={device.deviceId}>
                        {device.label || `Microphone ${index + 1}`}
                      </Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              </SettingsRow>
              <SettingsRow title="Speakers" stacked id="output-device">
                <Select.Root
                  type="single"
                  value={settings.value.voiceOutputDeviceId}
                  onValueChange={(value) => setAudioDevice('output', value)}
                >
                  <Select.Trigger id="output-device" class="w-full">
                    {settings.value.voiceOutputDeviceId === 'default'
                      ? 'Default output'
                      : (audioDevices.output.find(
                          (d) => d.deviceId === settings.value.voiceOutputDeviceId
                        )?.label ?? 'Unknown output')}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="default">Default output</Select.Item>
                    {#each audioDevices.output as device, index}
                      <Select.Item value={device.deviceId}>
                        {device.label || `Output device ${index + 1}`}
                      </Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              </SettingsRow>
              {#if audioDeviceError}
                <p class="px-4 py-2 text-xs text-destructive" aria-live="polite">
                  {audioDeviceError}
                </p>
              {/if}
            </SettingsGroup>

            <SettingsGroup title="Voice processing">
              <SettingsRow
                title="Echo cancellation"
                description="Turn off if it interferes with noise suppression."
                id="echo"
              >
                <Switch
                  id="echo"
                  checked={settings.value.voiceEchoCancellation}
                  onCheckedChange={(enabled) => voice.setEchoCancellation(enabled)}
                />
              </SettingsRow>
              <SettingsRow
                title="Automatic gain control"
                description="Keep your microphone volume steady."
                id="agc"
              >
                <Switch
                  id="agc"
                  checked={settings.value.voiceAutoGainControl}
                  onCheckedChange={(enabled) => voice.setAutoGainControl(enabled)}
                />
              </SettingsRow>
              <SettingsRow
                title="Noise suppression"
                description="Reduce background noise."
                id="noise"
              >
                <Switch
                  id="noise"
                  checked={settings.value.noiseCancellation}
                  onCheckedChange={(enabled) => voice.setNoiseCancellation(enabled)}
                />
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup title="Screen sharing">
              <SettingsRow
                title="Share system audio"
                description="Include your computer's sound when you share your screen."
                id="system-audio"
              >
                <Switch
                  id="system-audio"
                  checked={settings.value.screenShareSystemAudio}
                  onCheckedChange={(enabled) => voice.setScreenShareSystemAudio(enabled)}
                />
              </SettingsRow>
            </SettingsGroup>
          </Tabs.Content>

          <Tabs.Content value="langt" class="space-y-6 outline-none">
            {@render head('Language & time', 'Set your language and how times are shown.')}

            <SettingsGroup title="Language">
              <!-- localization should be properly implemented at some point -->
              <SettingsRow title="Display language" stacked id="language">
                <Select.Root
                  type="single"
                  value={settings.value.language}
                  onValueChange={(value) => (settings.value.language = value)}
                >
                  <Select.Trigger id="language" class="w-full">
                    {languageOptions.find((l) => l.value === settings.value.language)?.label ??
                      'Select language'}
                  </Select.Trigger>
                  <Select.Content>
                    {#each languageOptions as lang}
                      <Select.Item value={lang.value}>{lang.label}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup title="Time format">
              <RadioGroup.Root
                value={settings.value.timeFormat}
                onValueChange={(value) => (settings.value.timeFormat = value as TimeFormat)}
                class="gap-0 divide-y"
              >
                {#each timeFormats as format (format.value)}
                  <Label
                    for={`time-${format.value}`}
                    class="flex cursor-pointer items-center justify-between gap-4 px-4 py-3"
                  >
                    <span>
                      <span class="block text-sm font-medium">{format.label}</span>
                      <span class="mt-0.5 block text-xs font-normal text-muted-foreground"
                        >{format.example}</span
                      >
                    </span>
                    <RadioGroup.Item value={format.value} id={`time-${format.value}`} />
                  </Label>
                {/each}
              </RadioGroup.Root>
            </SettingsGroup>
          </Tabs.Content>

          {#if launchPrefs}
            <Tabs.Content value="desktop" class="space-y-6 outline-none">
              {@render head('Desktop app', 'How Novarum behaves on this computer.')}

              <SettingsGroup title="Startup">
                <SettingsRow
                  title="Launch at startup"
                  description="Open Novarum when you log in to your computer."
                  id="auto-launch"
                >
                  <Switch
                    id="auto-launch"
                    checked={launchPrefs.autoLaunch}
                    onCheckedChange={(autoLaunch) => setLaunchPref({ autoLaunch })}
                  />
                </SettingsRow>
                <SettingsRow
                  title="Start in the background"
                  description="Keep the window hidden in the tray when Novarum launches at startup."
                  id="start-hidden"
                >
                  <Switch
                    id="start-hidden"
                    checked={launchPrefs.startHidden}
                    disabled={!launchPrefs.autoLaunch}
                    onCheckedChange={(startHidden) => setLaunchPref({ startHidden })}
                  />
                </SettingsRow>
              </SettingsGroup>

              <SettingsGroup title="Updates">
                <SettingsRow
                  title="Update automatically"
                  description="Download new versions in the background and install them when you quit Novarum."
                  id="auto-update"
                >
                  <Switch
                    id="auto-update"
                    checked={launchPrefs.autoUpdate}
                    onCheckedChange={(autoUpdate) => setLaunchPref({ autoUpdate })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={`Novarum Desktop v${desktopVersion}`}
                  description={updateMessage}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updateState === 'checking'}
                    onclick={checkForUpdates}
                  >
                    <RefreshCw
                      class={cn('size-3.5', updateState === 'checking' && 'animate-spin')}
                    />
                    Check for updates
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            </Tabs.Content>
          {/if}
        </div>
      </div>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>

{#snippet colorActions(cancel: () => void)}
  <div class="flex items-center justify-between gap-3 border-t px-3 py-2.5">
    <p class="text-xs text-destructive">{avatarColorError ?? ''}</p>
    <div class="flex gap-2">
      <Button variant="ghost" size="sm" disabled={avatarColorLoading} onclick={cancel}
        >Cancel</Button
      >
      <Button size="sm" disabled={avatarColorLoading} onclick={saveAvatarColor}>
        {avatarColorLoading ? 'Saving…' : 'Save colors'}
      </Button>
    </div>
  </div>
{/snippet}

<AvatarCropDialog
  bind:open={cropOpen}
  file={cropFile}
  onCrop={(blob) => uploadMedia(blob, cropTarget)}
  title={cropTarget === 'banner' ? 'Crop Profile Banner' : 'Crop Avatar'}
  description={cropTarget === 'banner'
    ? 'Adjust the image to fit your profile banner.'
    : 'Adjust the image to fit your profile.'}
  actionLabel={cropTarget === 'banner' ? 'Use Banner' : 'Use Avatar'}
  outputWidth={cropTarget === 'banner' ? 960 : 512}
  outputHeight={cropTarget === 'banner' ? 320 : 512}
/>
