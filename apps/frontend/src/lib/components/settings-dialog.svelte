<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
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
    ChevronRight,
    ArrowLeft,
  } from '@lucide/svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { getErrorMessage, useSession } from '$lib/session.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';
  import Avatar from './avatar.svelte';
  import AnimatedImage from './animated-image.svelte';
  import { settings, type TimeFormat } from '$lib/settings.svelte';
  import type { Voice } from '$lib/voice.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import {
    getNotificationPermission,
    notificationSound,
    notificationsSupported,
    requestNotificationPermission,
  } from '$lib/notifications';
  import { onMount } from 'svelte';
  import { getAnchorInfo } from '$lib/api';
  import * as ColorPicker from '$lib/components/ui/color-picker/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import QRCode from 'qrcode';
  import { cn } from '$lib/utils';
  import { device } from '$lib/device.svelte';

  const menuItems = [
    { value: 'account', label: 'Account', desc: 'Profile, avatar, display name', icon: User },
    { value: 'security', label: 'Security', desc: 'MFA, authenticator app', icon: ShieldCheck },
    { value: 'appearance', label: 'Appearance', desc: 'Dark mode, QuickCSS, icons', icon: Palette },
    { value: 'notifications', label: 'Notifications', desc: 'Push, sounds, preview', icon: Bell },
    { value: 'voice', label: 'Voice & Audio', desc: 'Devices, volume, noise suppression', icon: Volume2 },
    { value: 'langt', label: 'Language & Time', desc: 'Language, time format', icon: Languages },
  ];

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
  let mentionSound = $state(true);
  let showOnlineStatus = $state(true);
  let logoutLoading = $state(false);
  let audioDevices = $state<{ input: MediaDeviceInfo[]; output: MediaDeviceInfo[] }>({
    input: [],
    output: [],
  });
  let audioDeviceError = $state<string | null>(null);
  let activeTab = $state('account');
  let mobileView = $state<'menu' | string>('menu');
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
  const frontendVersion = __FRONTEND_VERSION__;
  const gitCommit = __GIT_COMMIT_HASH__.slice(0, 7);

  let css = $state(
    localStorage.getItem('quickcss') ||
      '/* type your custom CSS code here (e.g. a shadcn-ui layout.css) */'
  );

  let quickCssTextarea: HTMLTextAreaElement;
  let quickCssPre: HTMLPreElement;

  function escapeCss(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }

  function highlightCss(code: string) {
    let text = code;
    if (text.endsWith('\n')) text += ' ';

    const tokens: { re: RegExp; cls: string }[] = [
      { re: /\/\*[\s\S]*?\*\//g, cls: 'text-muted-foreground italic' },
      { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, cls: 'text-green-600 dark:text-green-400' },
      { re: /[.#][a-zA-Z_-][\w-]*/g, cls: 'text-blue-600 dark:text-blue-400 font-medium' },
      { re: /\b[a-zA-Z-]+(?=\s*:)/g, cls: 'text-amber-600 dark:text-amber-400' },
      { re: /#[0-9a-fA-F]{3,8}\b/g, cls: 'text-pink-600 dark:text-pink-400' },
      { re: /\b\d+(\.\d+)?(px|rem|em|%|vh|vw|s|ms|deg)?\b/g, cls: 'text-pink-600 dark:text-pink-400' },
      { re: /!important/g, cls: 'text-red-600 dark:text-red-400 font-semibold' },
    ];

    const escaped = escapeCss(text);
    const marks: { start: number; end: number; cls: string }[] = [];

    for (const { re, cls } of tokens) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(escaped))) {
        marks.push({ start: m.index, end: m.index + m[0].length, cls });
      }
    }

    marks.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: typeof marks = [];
    let lastEnd = 0;
    for (const mark of marks) {
      if (mark.start >= lastEnd) {
        kept.push(mark);
        lastEnd = mark.end;
      }
    }

    let out = '';
    let pos = 0;
    for (const { start, end, cls } of kept) {
      out += escaped.slice(pos, start);
      out += `<span class="${cls}">${escaped.slice(start, end)}</span>`;
      pos = end;
    }
    out += escaped.slice(pos);
    return out;
  }

  let quickCssHighlighted = $derived(highlightCss(css));

  function syncQuickCssScroll() {
    quickCssPre.scrollTop = quickCssTextarea.scrollTop;
    quickCssPre.scrollLeft = quickCssTextarea.scrollLeft;
  }

  function handleQuickCssKeydown(e: KeyboardEvent) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: start, selectionEnd: end } = quickCssTextarea;
      css = css.slice(0, start) + '  ' + css.slice(end);
      queueMicrotask(() => {
        quickCssTextarea.selectionStart = quickCssTextarea.selectionEnd = start + 2;
      });
    }
  }

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
    mobileView = 'menu';
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

  async function setPushNotifications(enabled: boolean) {
    if (!enabled || !notificationsSupported()) {
      settings.value.pushNotifications = false;
      return;
    }

    const permission = await getNotificationPermission();
    const granted =
      permission === 'granted' || (await requestNotificationPermission()) === 'granted';

    settings.value.pushNotifications = granted;
    if (granted) new Notification('Novarum notifications enabled');
  }

  async function refreshAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioDevices = {
        input: devices.filter(
          (device) => device.kind === 'audioinput' && device.deviceId !== 'default'
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

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'la', label: 'Latin' },
  ];

  // loadTotpSetup
  onMount(async () => {
    if (device.isPhonePortrait) {
      loadTotpSetup();
    }
	});
</script>

{#snippet accountContent()}
  <div class="space-y-3 pb-1">
    <section class="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div
        class="group relative h-32 overflow-hidden sm:h-36"
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
        {:else}
          <div
            class="absolute inset-0 opacity-30"
            style:background-image={'radial-gradient(circle at 20% 30%, white 0, transparent 35%), radial-gradient(circle at 80% 70%, black 0, transparent 40%)'}
          ></div>
        {/if}
        <div
          class="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-black/10"
        ></div>

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
          class="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/45 focus-visible:bg-black/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80 disabled:cursor-wait"
          disabled={mediaLoading !== null}
          onclick={() => bannerInput.click()}
        >
          <span
            class="flex items-center gap-2 rounded-md bg-black/55 px-3 py-1.5 text-xs font-medium opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            class:opacity-100={mediaLoading === 'banner'}
          >
            <Camera class="size-4" />
            {mediaLoading === 'banner' ? 'Uploading...' : 'Change banner'}
          </span>
        </button>
      </div>

      <div class="px-4 pb-4">
        <div
          class="pointer-events-none relative z-10 -mt-9 flex items-end justify-between gap-3"
        >
          <input
            bind:this={avatarInput}
            type="file"
            accept="image/gif,image/jpeg,image/png,image/webp"
            class="hidden"
            onchange={(event) => selectMedia(event, 'avatar')}
          />
          <div
            class="pointer-events-auto group relative size-20 shrink-0 overflow-hidden border-4 border-card shadow-md"
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
              class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/55 focus-visible:bg-black/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80 disabled:cursor-wait"
              disabled={mediaLoading !== null}
              onclick={() => avatarInput.click()}
            >
              <span
                class="flex flex-col items-center gap-0.5 text-[10px] font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                class:opacity-100={mediaLoading === 'avatar'}
              >
                <Camera class="size-4" />
                {mediaLoading === 'avatar' ? 'Uploading...' : ''}
              </span>
            </button>
          </div>

          <div class="pointer-events-auto mb-1 mt-12 flex flex-col items-end gap-2">
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-muted-foreground">Avatar color</span>
              <Popover.Root bind:open={avatarColorOpen}>
                <Popover.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="outline"
                      size="xs"
                      class="gap-1.5 px-2 font-mono"
                      aria-label={`Change avatar color, currently ${selectedAvatarColor}`}
                      title="Avatar color"
                    >
                      <span
                        class="size-3.5 rounded-full border border-black/15 ring-1 ring-white/20"
                        style:background-color={selectedAvatarColor}
                      ></span>
                      <span>{selectedAvatarColor.toUpperCase()}</span>
                    </Button>
                  {/snippet}
                </Popover.Trigger>

                <Popover.Content align="end" class="w-auto overflow-hidden p-0">
                  <ColorPicker.Root
                    bind:value={selectedAvatarColor}
                    formats={['hex']}
                    class="w-[min(350px,calc(100vw-3rem))] rounded-none border-0 shadow-none"
                  />
                  <div class="flex items-center justify-between gap-3 border-t px-3 py-2.5">
                    <p class="text-[11px] text-destructive">{avatarColorError ?? ''}</p>
                    <div class="flex gap-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={avatarColorLoading}
                        onclick={() => (avatarColorOpen = false)}>Cancel</Button
                      >
                      <Button
                        size="xs"
                        disabled={avatarColorLoading}
                        onclick={saveAvatarColor}
                      >
                        {avatarColorLoading ? 'Saving...' : 'Save color'}
                      </Button>
                    </div>
                  </div>
                </Popover.Content>
              </Popover.Root>
            </div>

            <div class="flex items-center gap-2">
              <span class="text-[11px] text-muted-foreground">Speaking ring</span>
              <Popover.Root bind:open={speakingRingOpen}>
                <Popover.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="outline"
                      size="xs"
                      class="gap-1.5 px-2 font-mono"
                      aria-label={`Change speaking ring color, currently ${selectedSpeakingRing}`}
                      title="Speaking ring color"
                    >
                      <span
                        class="size-3.5 rounded-full border border-black/15 ring-1 ring-white/20"
                        style:background-color={selectedSpeakingRing}
                      ></span>
                      <span>{selectedSpeakingRing.toUpperCase()}</span>
                    </Button>
                  {/snippet}
                </Popover.Trigger>

                <Popover.Content align="end" class="w-auto overflow-hidden p-0">
                  <ColorPicker.Root
                    bind:value={selectedSpeakingRing}
                    formats={['hex']}
                    class="w-[min(350px,calc(100vw-3rem))] rounded-none border-0 shadow-none"
                  />
                  <div class="flex items-center justify-between gap-3 border-t px-3 py-2.5">
                    <p class="text-[11px] text-destructive">{avatarColorError ?? ''}</p>
                    <div class="flex gap-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={avatarColorLoading}
                        onclick={() => (speakingRingOpen = false)}>Cancel</Button
                      >
                      <Button
                        size="xs"
                        disabled={avatarColorLoading}
                        onclick={saveAvatarColor}
                      >
                        {avatarColorLoading ? 'Saving...' : 'Save color'}
                      </Button>
                    </div>
                  </div>
                </Popover.Content>
              </Popover.Root>
            </div>
          </div>
        </div>

        <div class="mt-3 flex items-end justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-base font-semibold">
              {session.user?.displayName || session.user?.username || 'Your profile'}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              {session.user?.handle || `@${session.user?.username ?? 'you'}`}
            </p>
          </div>

          <!-- TODO: pronouns
          <div class="grid shrink-0 gap-1.5">
            <Label for="pronouns">Pronouns</Label>
            <Input
              id="pronouns"
              placeholder="e.g. they/them"
              class="h-9 w-36 bg-background"
            />
          </div>
          -->
        </div>

        {#if mediaError}
          <p class="mt-3 text-xs text-destructive">{mediaError}</p>
        {/if}
      </div>
    </section>

    <section class="rounded-xl border bg-card">
      <div class="border-b px-4 py-2">
        <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          My account
        </p>
      </div>
      <div class="grid gap-4 px-4 py-2 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="display-name">Display name</Label>
          <Input id="display-name" bind:value={displayName} class="h-9 bg-background" />
          <p class="text-[10px] text-muted-foreground">Shown to people you chat with.</p>
        </div>
        <div class="grid gap-1.5">
          <Label for="email">Email address</Label>
          <Input id="email" type="email" bind:value={email} class="h-9 bg-background" />
          <p class="text-[10px] text-muted-foreground">Only visible to you.</p>
        </div>
      </div>
    </section>

    <section class="rounded-xl border bg-card">
      <div class="flex items-center justify-between border-b px-4 py-2">
        <div>
          <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            About me
          </p>
        </div>
        <span class="font-mono text-[10px] text-muted-foreground">{about.length}/512</span>
      </div>
      <div class="px-4 py-2">
        <textarea
          id="about"
          bind:value={about}
          maxlength="512"
          rows="4"
          placeholder="What should people know about you?"
          class="w-full resize-none rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-relaxed outline-none transition-shadow placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          oninput={() => (aboutSaved = false)}></textarea>
        <div class="mt-1 flex items-center justify-between gap-3">
          <p class="text-xs text-destructive">{aboutError ?? ''}</p>
          <Button size="xs" disabled={aboutLoading} onclick={saveAbout}>
            {aboutLoading ? 'Saving...' : aboutSaved ? 'Saved!' : 'Save about'}
          </Button>
        </div>
      </div>
    </section>
  </div>
{/snippet}

{#snippet securityContent()}
  <div class="space-y-3 pb-1">
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
      <div class="flex items-center justify-between gap-4 px-4 py-3">
        <div class="flex min-w-0 items-start gap-3">
          <div
            class={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground',
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
          <span class="text-xs text-muted-foreground">Preparing authenticator setup...</span
          >
        </div>
      {:else if totpState === 'enabled'}
        <div class="flex items-center justify-between gap-4 px-4 py-3">
          <div class="flex min-w-0 items-start gap-3">
            <div
              class={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md',
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
              {#if device.isComputer}
              <img
                src={totpQr}
                alt="Authenticator setup QR code"
                class="size-40 not-hover:blur-xs transition not-hover:blur-none"
              />
              {:else}
              <img
                src={totpQr}
                alt="Authenticator setup QR code"
                class="size-40"
              />
              {/if}
            </div>

            <div class="min-w-0 space-y-2">
              <div>
                <p class="text-xs font-medium">Can't scan it?</p>
                <p class="text-[11px] text-muted-foreground">
                  Enter this setup key manually. Keep it private.
                </p>
              </div>
              <div class="flex items-stretch border bg-muted/40">
                {#if device.isComputer}
                <code
                  class="min-w-0 flex-1 break-all px-2 py-2 font-mono text-[13px] not-hover:blur-xs transition blur-none"
                >
                  {totpSecret}
                </code>
                {:else}
                <!-- not-hover:blur-xs transition blur-none -->
                <code
                  class="min-w-0 flex-1 break-all px-2 py-2 font-mono text-[13px]"
                >
                  {totpSecret}
                </code>
                {/if}
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
    {/if}
  </div>
{/snippet}

{#snippet appearanceContent()}
  <div class="grid gap-3">
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Dark Mode</p>
        {#if settings.value.darkMode}
          <p class="text-[11px] text-muted-foreground">It's good for your eyes!</p>
        {:else}
          <p class="text-[11px] text-muted-foreground">
            Trust me, it's good for your eyes!!! Turn me back on :)
          </p>
        {/if}
      </div>
      <Switch bind:checked={settings.value.darkMode} />
    </div>
    <div class="items-center justify-between">
      <p class="text-xs font-medium">QuickCSS</p>
      <div class="relative mt-1 min-h-[250px] w-full overflow-hidden rounded-md border bg-input/30">
        <pre
          bind:this={quickCssPre}
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs leading-relaxed [tab-size:2]"
        >{@html quickCssHighlighted}</pre>
        <textarea
          bind:this={quickCssTextarea}
          bind:value={css}
          spellcheck="false"
          oninput={syncQuickCssScroll}
          onscroll={syncQuickCssScroll}
          onkeydown={handleQuickCssKeydown}
          class="absolute inset-0 resize-none overflow-auto whitespace-pre-wrap break-words border-0 bg-transparent p-2 font-mono text-xs leading-relaxed text-transparent caret-foreground outline-none [tab-size:2]"
        ></textarea>
      </div>
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Compact Mode</p>
        <p class="text-[11px] text-muted-foreground">Reduce spacing between messages</p>
      </div>
      <Switch bind:checked={settings.value.compactMode} disabled />
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Show Member List</p>
        <p class="text-[11px] text-muted-foreground">Display member sidebar in channels</p>
      </div>
      <Switch bind:checked={settings.value.showMemberList} />
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Circle icons</p>
        <p class="text-[11px] text-muted-foreground">
          Replace default square icons with round ones
        </p>
      </div>
      <Switch bind:checked={settings.value.circleIcons} />
    </div>
    <!-- tbd
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Rounded borders</p>
        <p class="text-[11px] text-muted-foreground">
          You get it.
        </p>
      </div>
      <Switch bind:checked={settings.value.roundedBorders} />
    </div>
  </div> -->
  </div>
{/snippet}

{#snippet notificationsContent()}
  <div class="grid gap-3">
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Push Notifications</p>
        <p class="text-[11px] text-muted-foreground">
          Receive notifications for mentions and replies
        </p>
      </div>
      <Switch
        checked={settings.value.pushNotifications}
        onCheckedChange={setPushNotifications}
      />
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Message Preview</p>
        <p class="text-[11px] text-muted-foreground">
          Show message content in notifications
        </p>
      </div>
      <Switch bind:checked={settings.value.messagePreview} />
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
    <div class="grid gap-1.5">
      <Label for="input-volume">Notification Volume</Label>
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
    </div>
  </div>
{/snippet}

{#snippet voiceContent()}
  <div class="grid gap-3">
    <div class="grid gap-1.5">
      <Label for="input-device">Input Device</Label>
      <Select.Root
        type="single"
        value={settings.value.voiceInputDeviceId}
        onValueChange={(value) => setAudioDevice('input', value)}
      >
        <Select.Trigger
          >{settings.value.voiceInputDeviceId === 'default'
            ? 'Default microphone'
            : audioDevices.input.find(
                (d) => d.deviceId === settings.value.voiceInputDeviceId
              )?.label}</Select.Trigger
        >
        <Select.Content>
          <Select.Item value="default">Default microphone</Select.Item>
          {#each audioDevices.input as dev, index}
            <Select.Item value={dev.deviceId}>
              {dev.label || `Microphone ${index + 1}`}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="grid gap-1.5">
      <Label for="output-device">Output Device</Label>
      <Select.Root
        type="single"
        value={settings.value.voiceOutputDeviceId}
        onValueChange={(value) => setAudioDevice('output', value)}
      >
        <Select.Trigger
          >{settings.value.voiceOutputDeviceId === 'default'
            ? 'Default output'
            : audioDevices.output.find(
                (d) => d.deviceId === settings.value.voiceOutputDeviceId
              )?.label}</Select.Trigger
        >
        <Select.Content>
          <Select.Item value="default">Default output</Select.Item>
          {#each audioDevices.output as dev, index}
            <Select.Item value={dev.deviceId}>
              {dev.label || `Output device ${index + 1}`}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    {#if audioDeviceError}
      <p class="text-[11px] text-destructive">{audioDeviceError}</p>
    {/if}
    <div class="grid gap-1.5">
      <Label for="input-volume">Input Volume</Label>
      <Slider
        type="single"
        min={0}
        max={100}
        step={1}
        value={80}
        onValueChange={(value) => console.log('Input volume changed to:', value)}
      />
    </div>
    <div class="grid gap-1.5">
      <Label for="output-volume">Output Volume</Label>
      <Slider
        type="single"
        min={0}
        max={100}
        step={1}
        value={100}
        onValueChange={(value) => console.log('Output volume changed to:', value)}
      />
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Echo Cancellation</p>
        <p class="text-[11px] text-muted-foreground">
          Turn off if it interferes with noise suppression.
        </p>
      </div>
      <Switch
        checked={settings.value.voiceEchoCancellation}
        onCheckedChange={(enabled) => voice.setEchoCancellation(enabled)}
      />
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Automatic Gain Control</p>
        <p class="text-[11px] text-muted-foreground">
          Automatically balances microphone volume.
        </p>
      </div>
      <Switch
        checked={settings.value.voiceAutoGainControl}
        onCheckedChange={(enabled) => voice.setAutoGainControl(enabled)}
      />
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs font-medium">Noise Suppression</p>
        <p class="text-[11px] text-muted-foreground">Reduce background noise</p>
      </div>
      <Switch
        checked={settings.value.noiseCancellation}
        onCheckedChange={(enabled) => voice.setNoiseCancellation(enabled)}
      />
    </div>
  </div>
{/snippet}

{#snippet langtContent()}
  <div>
    <!-- localization should be properly implemented at some point -->
    <p class="text-xs font-medium">Language</p>
    <p class="text-[11px] text-muted-foreground">
      Choose your preferred language for Novarum to use.
    </p>
    <div
      class="mt-2"
      class:mb-3={device.isPhonePortrait}
    >
      <Select.Root
        type="single"
        value={settings.value.language}
        onValueChange={(value) => (settings.value.language = value)}
      >
        <Select.Trigger>
          {languageOptions.find((l) => l.value === settings.value.language)?.label ??
            'Select language'}
        </Select.Trigger>
        <Select.Content>
          {#each languageOptions as lang}
            <Select.Item value={lang.value}>{lang.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  </div>
  <div class="grid gap-3">
    <div>
      <p class="text-xs font-medium">Time Format</p>
      <p class="text-[11px] text-muted-foreground">Select your time format!</p>
    </div>
    <RadioGroup.Root
      value={settings.value.timeFormat}
      onValueChange={(value) => (settings.value.timeFormat = value as TimeFormat)}
      class="grid gap-3"
    >
      <div class="flex items-center gap-2">
        <!-- doesnt do anything -->
        <RadioGroup.Item value="auto" id="autohr" />
        <Label for="autohr">Auto</Label>
      </div>
      <div class="flex items-center gap-2">
        <RadioGroup.Item value="12hr" id="12hr" />
        <Label for="12hr">12-hour</Label>
      </div>
      <div class="flex items-center gap-2">
        <RadioGroup.Item value="24hr" id="24hr" />
        <Label for="24hr">24-hour</Label>
      </div>
    </RadioGroup.Root>
  </div>
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-2xl">
    {#if device.isPhone}
      {#if mobileView === 'menu'}
        <Dialog.Header>
          <Dialog.Title>User Settings</Dialog.Title>
          <Dialog.Description>Manage your account, security, and preferences.</Dialog.Description>
        </Dialog.Header>

        <div class="overflow-hidden rounded-xl border bg-card">
          {#each menuItems as item, i}
            {#if i > 0}<div class="border-t"></div>{/if}
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent active:bg-accent"
              onclick={() => (mobileView = item.value)}
            >
              <div class="flex size-9 shrink-0 items-center justify-center bg-muted" class:rounded-full={settings.value.circleIcons}>
                <item.icon class="size-4.5" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium">{item.label}</p>
                <p class="text-xs text-muted-foreground">{item.desc}</p>
              </div>
              <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
            </button>
          {/each}
        </div>

        <div class="flex flex-col gap-0.5 pt-2 text-[11px] text-muted-foreground">
          <p>Frontend: v{frontendVersion}</p>
          <p>Anchor: {anchorVersion ?? 'Unknown'}</p>
          {#if desktopVersion}
            <p>Desktop: v{desktopVersion}</p>
          {/if}
          <p>
            Commit: <a
              href={`https://github.com/novarumsocial/novarum/commit/${gitCommit}`}
              class="underline">{gitCommit}</a
            >
          </p>
        </div>

        <Button
          variant="destructive"
          size="sm"
          class="w-full"
          disabled={logoutLoading}
          onclick={logout}
        >
          <LogOut class="size-3.5" />
          Logout
        </Button>
      {:else}
        <div class="flex items-center gap-3 pb-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onclick={() => (mobileView = 'menu')}
          >
            <ArrowLeft class="size-4" />
          </Button>
          <div class="min-w-0">
            <p class="text-sm font-semibold">
              {menuItems.find((i) => i.value === mobileView)?.label}
            </p>
            <p class="text-xs text-muted-foreground">
              {menuItems.find((i) => i.value === mobileView)?.desc}
            </p>
          </div>
        </div>

        <div class="min-h-0 flex-1">
          {#if mobileView === 'account'}{@render accountContent()}{/if}
          {#if mobileView === 'security'}{@render securityContent()}{/if}
          {#if mobileView === 'appearance'}{@render appearanceContent()}{/if}
          {#if mobileView === 'notifications'}{@render notificationsContent()}{/if}
          {#if mobileView === 'voice'}{@render voiceContent()}{/if}
          {#if mobileView === 'langt'}{@render langtContent()}{/if}
        </div>
      {/if}
    {:else}
      <Dialog.Header>
        <Dialog.Title>User Settings</Dialog.Title>
        <Dialog.Description>Manage your account, security, and preferences.</Dialog.Description>
      </Dialog.Header>

      <Tabs.Root
        bind:value={activeTab}
        orientation="vertical"
        class="flex flex-col gap-4 sm:h-[480px] sm:flex-row sm:gap-0"
      >
        <div
          class="flex min-w-0 shrink-0 flex-col gap-2 sm:w-44 sm:border-r sm:border-border sm:pr-2"
        >
          <Tabs.List
            class="flex h-auto w-full items-stretch justify-start gap-0.5 overflow-x-auto bg-transparent p-0 sm:flex-col sm:overflow-visible"
          >
            <Tabs.Trigger
              value="account"
              class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
            >
              <User class="size-3.5" />
              Account
            </Tabs.Trigger>

            <Tabs.Trigger
              value="security"
              class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
            >
              <ShieldCheck class="size-3.5" />
              Security
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

            <Tabs.Trigger
              value="langt"
              class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
            >
              <Languages class="size-3.5" />
              Language & Time
            </Tabs.Trigger>
          </Tabs.List>

          <div class="flex flex-col gap-0.5 px-2 text-[11px] text-muted-foreground sm:mt-auto">
            <p>Frontend: v{frontendVersion}</p>
            <p>Anchor: {anchorVersion ?? 'Unknown'}</p>
            {#if desktopVersion}
              <p>Desktop: v{desktopVersion}</p>
            {/if}
            <p>
              Commit: <a
                href={`https://github.com/novarumsocial/novarum/commit/${gitCommit}`}
                class="underline">{gitCommit}</a
              >
            </p>
          </div>

          <Button
            variant="destructive"
            size="sm"
            class="w-full rounded-none"
            disabled={logoutLoading}
            onclick={logout}
          >
            <LogOut class="size-3.5" />
            Logout
          </Button>
        </div>

        <div class="min-w-0 flex-1 sm:pl-4">
          <Tabs.Content value="account" class="sm:h-full sm:overflow-y-auto sm:pr-1">
            {@render accountContent()}
          </Tabs.Content>

          <Tabs.Content value="security" class="sm:h-full sm:overflow-y-auto sm:pr-1">
            {@render securityContent()}
          </Tabs.Content>

          <Tabs.Content value="appearance" class="space-y-4">
            {@render appearanceContent()}
          </Tabs.Content>

          <Tabs.Content value="notifications" class="space-y-4">
            {@render notificationsContent()}
          </Tabs.Content>

          <Tabs.Content value="voice" class="space-y-4">
            {@render voiceContent()}
          </Tabs.Content>

          <Tabs.Content value="langt" class="space-y-4">
            {@render langtContent()}
          </Tabs.Content>
        </div>
      </Tabs.Root>
    {/if}
  </Dialog.Content>
</Dialog.Root>

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
