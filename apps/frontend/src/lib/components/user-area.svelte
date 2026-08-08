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
  } from '@lucide/svelte';
  import SettingsDialog from './settings-dialog.svelte';
  import MicLevelMeter from './mic-level-meter.svelte';
  import type { Voice } from '$lib/voice.svelte';
  import { cn } from '$lib/utils';
  import Avatar from './avatar.svelte';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import Switch from './ui/switch/switch.svelte';
  import Label from './ui/label/label.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { settings } from '$lib/settings.svelte';
  import type { SessionUser } from '$lib/session.svelte';

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
  let settingsOpen = $state(false);
  let loopbackPending = $state(false);
  let loopbackError = $state<string | null>(null);

  async function toggleAudioLoopback() {
    loopbackPending = true;
    loopbackError = null;

    try {
      await voice.setAudioLoopbackTesting(!voice.audioLoopbackTesting);
    } catch (error) {
      loopbackError = error instanceof Error ? error.message : 'Unknown playback error';
    } finally {
      loopbackPending = false;
    }
  }
</script>

<div class="w-74 shrink-0 border-t border-border bg-sidebar-accent/30">
  {#if voice.connected || voice.connecting}
    <div class="border-b border-border/80 px-3 py-2">
      <div class="flex items-center gap-2">
        <div
          class="flex size-8 items-center justify-center {voice.connecting
            ? 'bg-amber-500/10 text-amber-400'
            : 'bg-emerald-500/10 text-emerald-400'} text-xs font-bold"
        >
          <Signal class="size-4" />
        </div>
        <div class="min-w-0 flex-1">
          <p
            class="truncate text-xs font-semibold uppercase tracking-wide {voice.connecting
              ? 'text-amber-400'
              : 'text-emerald-400'}"
          >
            {voice.connecting ? 'Voice Connecting' : 'Voice Connected'}
          </p>
          <p class="truncate text-[11px] text-muted-foreground">
            {voiceChannelName ?? 'Voice channel'}
          </p>
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
              <div class="mt-2 flex items-center gap-2">
                <Button
                  class="flex-1"
                  size="sm"
                  variant={voice.audioLoopbackTesting ? 'secondary' : 'outline'}
                  disabled={loopbackPending}
                  aria-pressed={voice.audioLoopbackTesting}
                  onclick={toggleAudioLoopback}
                >
                  <Headphones data-icon="inline-start" />
                  {loopbackPending
                    ? voice.audioLoopbackTesting
                      ? 'Starting...'
                      : 'Stopping...'
                    : voice.audioLoopbackTesting
                      ? 'Stop test'
                      : 'Start test'}
                </Button>
                <MicLevelMeter stream={voice.audioLoopbackStream} />
              </div>
              {#if loopbackError}
                <p
                  class="mt-2 border border-destructive/20 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
                >
                  {loopbackError}
                </p>
              {/if}
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
    <div class="relative shrink-0">
      <Avatar
        src={user.avatarUrl}
        name={user.displayName || user.username}
        bgColor={user.avatarColor}
        class="size-8 text-xs"
      />
      {#if voice.connected && voice.voiceStates.get(user.id)?.speaking}
        <div
          class="pointer-events-none absolute inset-0 ring-2 ring-[#23a55a] ring-offset-2 ring-offset-sidebar"
          class:rounded-full={settings.value.circleIcons}
        ></div>
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
        onclick={() => (voice.selfDeafened ? voice.setDeafened(false) : voice.setMuted(!voice.selfMuted))}
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
        onclick={() => (settingsOpen = true)}
      >
        <Settings class="size-4" />
      </button>
    </div>
  </div>
</div>

<SettingsDialog bind:open={settingsOpen} {voice} />
