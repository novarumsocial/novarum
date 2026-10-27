<script lang="ts">
  import {
    AudioWaveform,
    Mic,
    MicOff,
    Headphones,
    HeadphoneOff,
    PhoneOff,
    Settings,
    Signal,
    SignalHigh,
    SignalLow,
    SignalMedium,
    SignalZero,
    Check,
    Plus,
  } from '@lucide/svelte';
  import SettingsDialog from './settings-dialog.svelte';
  import MicTest from './mic-test.svelte';
  import type { Voice } from '$lib/voice.svelte';
  import { cn } from '$lib/utils';
  import Avatar from './avatar.svelte';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import Switch from './ui/switch/switch.svelte';
  import Label from './ui/label/label.svelte';
  import {
    noiseModelLabels,
    settings,
    settingsDialog,
    type NoiseSuppressionModel,
  } from '$lib/settings.svelte';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { session, type SessionUser } from '$lib/session.svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { goto } from '$app/navigation';

  let {
    voice,
    user,
    voiceChannelName,
    onLeaveVoice,
  }: {
    voice: Voice;
    user: SessionUser;
    voiceChannelName: string | null;
    onLeaveVoice: () => void;
  } = $props();
  let acctSwitcherOpen = $state(false);
  const otherAccounts = $derived(
    session.accounts.filter((account) => account.homeServer !== anchor.homeServer)
  );
  let latency = $state<number | null>(null);

  const tiers = [
    { max: 60, icon: Signal, color: 'bg-emerald-500/10 text-emerald-400' },
    { max: 120, icon: SignalHigh, color: 'bg-lime-500/10 text-lime-400' },
    { max: 200, icon: SignalMedium, color: 'bg-amber-500/10 text-amber-400' },
    { max: Infinity, icon: SignalLow, color: 'bg-rose-500/10 text-rose-400' },
  ];
  const tier = $derived(
    voice.connecting
      ? { icon: SignalZero, color: 'bg-amber-500/10 text-amber-400' }
      : (tiers.find((t) => (latency ?? 0) < t.max) ?? tiers[0])
  );

  $effect(() => {
    const room = voice.connected ? voice.room : null;
    latency = null;
    if (!room) return;
    // Media-path RTT from the active ICE pair; the signal client's rtt runs over the
    // WebSocket and includes proxy/TLS/event-loop delay.
    const update = async () => {
      const pc = room.engine.pcManager;
      const stats = await (pc?.subscriber ?? pc?.publisher)?.getStats();
      stats?.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null)
          latency = Math.round(s.currentRoundTripTime * 1000);
      });
    };
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  });
</script>

<div class="w-74 shrink-0 border-t border-border bg-sidebar-accent/30">
  {#if voice.connected || voice.connecting}
    <div class="border-b border-border/80 px-3 py-2">
      <div class="flex items-center gap-2">
        <Tooltip.Root>
          <Tooltip.Trigger
            class="flex size-8 items-center justify-center text-xs font-bold transition-colors {tier.color}"
          >
            <tier.icon class="size-4" />
          </Tooltip.Trigger>
          {#if latency !== null}
            <Tooltip.Content side="top">{latency} ms</Tooltip.Content>
          {/if}
        </Tooltip.Root>
        <div class="min-w-0 flex-1">
          <p
            class="truncate text-xs font-semibold uppercase tracking-wide {voice.connecting
              ? 'text-amber-400'
              : 'text-emerald-400'}"
          >
            {voice.connecting ? 'Voice Connecting' : 'Voice Connected'}
          </p>
          <button
            type="button"
            class="m-0 block truncate border-0 bg-transparent p-0 text-left text-[11px] text-muted-foreground appearance-none hover:underline cursor-pointer"
            onclick={() => chat.selectChannel(voice.channelId!)}
          >
            {voiceChannelName ?? 'Voice channel'}
          </button>
        </div>
        <Popover.Root
          onOpenChange={(open) => {
            if (!open) void voice.setAudioLoopbackTesting(false);
          }}
        >
          <Popover.Trigger
            class={cn(
              'flex size-7 items-center justify-center transition-colors',
              voice.noiseCancellationEnabled
                ? 'text-primary hover:text-primary/80'
                : 'text-muted-foreground hover:text-sidebar-foreground'
            )}
            aria-label="Voice processing settings"
            aria-pressed={voice.noiseCancellationEnabled}
            title="Voice processing settings"
          >
            <AudioWaveform class="size-4" />
          </Popover.Trigger>
          <Popover.Content side="top" align="end" class="w-80 gap-0 overflow-hidden p-0">
            <div class="flex items-start justify-between gap-4 px-3.5 py-3">
              <div>
                <Label for="noise-cancellation-switch" class="text-xs font-medium">
                  Noise suppression
                </Label>
                <p class="mt-0.5 max-w-52 text-[11px] leading-relaxed text-muted-foreground">
                  Removes steady background noise
                </p>
              </div>
              <Switch
                id="noise-cancellation-switch"
                class="mt-0.5"
                checked={voice.noiseCancellationEnabled}
                disabled={voice.audioLoopbackTesting}
                onCheckedChange={(e) => voice.setNoiseCancellation(e)}
              />
            </div>

            {#if voice.noiseCancellationEnabled}
              <div class="flex items-center justify-between gap-4 px-3.5 pb-3">
                <Label for="noise-model-select" class="text-xs font-medium">Model</Label>
                <Select.Root
                  type="single"
                  value={settings.value.noiseSuppressionModel}
                  onValueChange={(model) =>
                    voice.setNoiseSuppressionModel(model as NoiseSuppressionModel)}
                >
                  <Select.Trigger
                    id="noise-model-select"
                    size="sm"
                    class="w-36"
                    disabled={voice.audioLoopbackTesting}
                  >
                    {noiseModelLabels[settings.value.noiseSuppressionModel]}
                  </Select.Trigger>
                  <Select.Content>
                    {#each Object.entries(noiseModelLabels) as [value, label]}
                      <Select.Item {value}>{label}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            <div class="border-t border-border bg-muted/20 px-3.5 py-3">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-medium text-popover-foreground">Microphone output</p>
                  <p class="mt-0.5 text-[11px] text-muted-foreground">
                    Make sure it sounds how you like!
                  </p>
                </div>
                {#if voice.audioLoopbackTesting}
                  <span class="flex items-center gap-1.5 text-[10px] font-medium text-destructive">
                    Listening
                  </span>
                {/if}
              </div>
              <div class="mt-2"><MicTest {voice} /></div>
            </div>
          </Popover.Content>
        </Popover.Root>

        <button
          class="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-300"
          class:rounded-full={settings.value.circleIcons}
          onclick={onLeaveVoice}
          aria-label="Leave call"
        >
          <PhoneOff class="size-4" />
        </button>
      </div>
    </div>
  {/if}

  <div class="flex h-14 items-center gap-2.5 px-3">
    <Popover.Root bind:open={acctSwitcherOpen}>
      <Popover.Trigger
        class="-ml-1.5 flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1 text-left transition-colors hover:bg-sidebar-accent"
        aria-label="Switch account"
      >
        <div class="relative shrink-0">
          <Avatar
            src={user.avatarUrl}
            name={user.displayName || user.username}
            bgColor={user.avatarColor}
            class="size-8 text-xs"
          />
          <span
            class="absolute -right-px -bottom-px size-2.5 border-2 border-sidebar bg-emerald-500"
          ></span>
          {#if settings.value.circleIcons}
            <span
              class="rounded-full absolute -right-px -bottom-px size-2.75 border-2 border-sidebar bg-emerald-500"
            ></span>
          {/if}
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium leading-tight text-sidebar-foreground">
            {user.displayName || user.username}
          </p>
          <p class="truncate text-[11px] text-muted-foreground">
            @{user.username}:{user.homeserver}
          </p>
        </div>
      </Popover.Trigger>
      <Popover.Content side="top" align="start" class="w-64 gap-0 p-1">
        <p class="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">Accounts</p>
        <div class="flex items-center gap-2.5 bg-accent/50 px-2 py-1.5">
          <Avatar
            src={user.avatarUrl}
            name={user.displayName || user.username}
            bgColor={user.avatarColor}
            class="size-7 text-[11px]"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium">{user.displayName || user.username}</p>
            <p class="truncate text-[11px] text-muted-foreground">{user.homeserver}</p>
          </div>
          <Check class="size-4 text-primary" />
        </div>
        {#each otherAccounts as account (account.homeServer)}
          <button
            type="button"
            class="flex w-full items-center gap-2.5 px-2 py-1.5 text-left transition-colors hover:bg-accent"
            onclick={() => {
              session.switchAccount(account.homeServer);
              acctSwitcherOpen = false;
            }}
          >
            <Avatar
              src={account.avatarUrl}
              name={account.displayName || account.username}
              bgColor={account.avatarColor}
              class="size-7 text-[11px]"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-medium">{account.displayName || account.username}</p>
              <p class="truncate text-[11px] text-muted-foreground">{account.homeServer}</p>
            </div>
          </button>
        {/each}
        <div class="my-1 border-t border-border"></div>
        <button
          type="button"
          class="flex w-full items-center gap-2.5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
          onclick={() => goto('/login?add')}
        >
          <span class="flex size-7 items-center justify-center text-muted-foreground">
            <Plus class="size-4" />
          </span>
          Add account
        </button>
      </Popover.Content>
    </Popover.Root>
    <div class="flex items-center gap-0.5">
      <button
        class={cn(
          'flex size-7 items-center justify-center transition-colors',
          voice.selfMuted && !voice.selfDeafened
            ? 'text-rose-400 hover:text-rose-300'
            : voice.selfDeafened
              ? 'text-rose-400 hover:text-rose-300'
              : 'text-muted-foreground hover:text-sidebar-foreground'
        )}
        onclick={() =>
          voice.selfDeafened ? voice.setDeafened(false) : voice.setMuted(!voice.selfMuted)}
        aria-label={voice.selfDeafened ? 'Undeafen' : voice.selfMuted ? 'Unmute' : 'Mute'}
      >
        {#if voice.selfMuted}
          <MicOff class="size-4" />
        {:else}
          <Mic class="size-4" />
        {/if}
      </button>
      <button
        class={cn(
          'flex size-7 items-center justify-center transition-colors',
          voice.selfDeafened
            ? 'text-rose-400 hover:text-rose-300'
            : 'text-muted-foreground hover:text-sidebar-foreground'
        )}
        onclick={() => voice.setDeafened(!voice.selfDeafened)}
        disabled={voice.audioLoopbackTesting}
        aria-label={voice.selfDeafened ? 'Undeafen' : 'Deafen'}
      >
        {#if voice.selfDeafened}
          <HeadphoneOff class="size-4" />
        {:else}
          <Headphones class="size-4" />
        {/if}
      </button>
      <button
        class="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-sidebar-foreground"
        aria-label="User settings"
        onclick={() => (settingsDialog.open = true)}
      >
        <Settings class="size-4" />
      </button>
    </div>
  </div>
</div>

<SettingsDialog bind:open={settingsDialog.open} {voice} />
