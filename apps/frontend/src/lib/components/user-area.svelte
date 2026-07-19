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
  import type { Voice } from '$lib/voice.svelte';
  import { cn } from '$lib/utils';
  import Avatar from './avatar.svelte';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import Switch from './ui/switch/switch.svelte';
  import Label from './ui/label/label.svelte';
  import * as Slider from '$lib/components/ui/slider/index.js';
  import { Button } from '$lib/components/ui/button/index.js';

  type UserAreaUser = {
    username: string;
    displayName?: string | null;
    homeserver: string;
    avatarUrl?: string | null;
  };

  let {
    voice,
    user,
    voiceChannelName,
    onLeaveVoice,
  }: {
    voice: Voice;
    user: UserAreaUser;
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
            aria-label={voice.noiseCancellationEnabled
              ? 'Disable noise cancellation'
              : 'Enable noise cancellation'}
            aria-pressed={voice.noiseCancellationEnabled}
            title={voice.noiseCancellationEnabled
              ? 'Disable noise cancellation'
              : 'Enable noise cancellation'}
          >
            <AudioWaveform class="size-4" />
          </Popover.Trigger>
          <Popover.Content side="top">
            <div class="flex items-center space-x-2">
              <Label for="noise-cancellation-switch">Noise cancellation</Label>
              <Switch
                id="noise-cancellation-switch"
                checked={voice.noiseCancellationEnabled}
                disabled={voice.audioLoopbackTesting}
                onCheckedChange={(e) => voice.setNoiseCancellation(e)}
              />
            </div>
            <div class="mt-2 text-xs text-muted-foreground">
              <p class="text-popover-foreground">Level</p>
              Higher levels may reduce voice quality. Lower if issues occur.
              <Slider.Root
                type="single"
                class="mt-3 mb-4"
                min={10}
                max={100}
                step={10}
                disabled={voice.audioLoopbackTesting}
                value={voice.noiseCancellationLevel}
                onValueCommit={(e) => voice.setNoiseCancellationLevel(e)}
              >
                {#snippet children({ tickItems })}
                  {#each tickItems as { value, index } (index)}
                    <Slider.Tick {index} />
                    <Slider.TickLabel {index} position="bottom">
                      {value}
                    </Slider.TickLabel>
                  {/each}
                {/snippet}
              </Slider.Root>
            </div>

            <div class="mt-3 border-t border-border pt-3">
              <p class="text-xs font-medium text-popover-foreground">Mic test</p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">
                Hear your microphone with the current noise cancellation.
              </p>
              <Button
                class="mt-2 w-full"
                size="sm"
                variant={voice.audioLoopbackTesting ? 'destructive' : 'outline'}
                disabled={loopbackPending}
                aria-pressed={voice.audioLoopbackTesting}
                onclick={toggleAudioLoopback}
              >
                <AudioWaveform data-icon="inline-start" />
                {loopbackPending
                  ? voice.audioLoopbackTesting
                    ? 'Starting...'
                    : 'Stopping...'
                  : voice.audioLoopbackTesting
                    ? 'Stop test'
                    : 'Start test'}
              </Button>
              {#if loopbackError}
                <p class="mt-1.5 text-[11px] text-destructive">
                  {loopbackError}
                </p>
              {:else if voice.audioLoopbackTesting}
                <p class="mt-1.5 text-[11px] text-muted-foreground">
                  Deafen is locked on while testing.
                </p>
              {/if}
            </div>
          </Popover.Content>
        </Popover.Root>

        <button
          class="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-300"
          onclick={onLeaveVoice}
          aria-label="Leave call"
        >
          <PhoneOff class="size-4" />
        </button>
      </div>
    </div>
  {/if}

  <div class="flex h-14 items-center gap-2.5 px-3">
    <Avatar src={user.avatarUrl} name={user.displayName || user.username} class="size-8 text-xs" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium leading-tight text-sidebar-foreground">
        {user.displayName || user.username}
      </p>
      <p class="truncate text-[11px] text-muted-foreground">
        @{user.username}@{user.homeserver}
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
        onclick={() => voice.setMuted(!voice.selfMuted)}
        disabled={voice.selfDeafened}
        aria-label={voice.selfMuted ? 'Unmute' : 'Mute'}
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

<SettingsDialog bind:open={settingsOpen} />
