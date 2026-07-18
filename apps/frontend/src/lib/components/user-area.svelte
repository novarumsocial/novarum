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
        <button
          class={cn(
            'flex size-7 items-center justify-center transition-colors',
            voice.noiseCancellationEnabled
              ? 'text-primary hover:text-primary/80'
              : 'text-muted-foreground hover:text-sidebar-foreground'
          )}
          onclick={() => voice.setNoiseCancellation(!voice.noiseCancellationEnabled)}
          aria-label={voice.noiseCancellationEnabled
            ? 'Disable noise cancellation'
            : 'Enable noise cancellation'}
          aria-pressed={voice.noiseCancellationEnabled}
          title={voice.noiseCancellationEnabled
            ? 'Disable noise cancellation'
            : 'Enable noise cancellation'}
        >
          <AudioWaveform class="size-4" />
        </button>
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
