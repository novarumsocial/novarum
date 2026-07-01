<script lang="ts">
  import { Mic, MicOff, Headphones, HeadphoneOff, Settings } from '@lucide/svelte';
  import SettingsDialog from './settings-dialog.svelte';
  import type { Voice } from '$lib/voice.svelte';
  import { cn } from '$lib/utils';

  type UserAreaUser = {
    username: string;
    displayName?: string | null;
    homeserver: string;
  };

  let {
    voice,
    user,
  }: {
    voice: Voice;
    user: UserAreaUser;
  } = $props();
  let settingsOpen = $state(false);
</script>

<div
  class="flex h-14 shrink-0 items-center gap-2.5 border-t border-border bg-sidebar-accent/30 px-3"
>
  <div
    class="flex size-8 shrink-0 items-center justify-center bg-primary/20 text-xs font-bold text-primary"
  >
    {user.username.slice(0, 1).toUpperCase() || '?'}
  </div>
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
            : 'text-muted-foreground hover:text-sidebar-foreground',
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
          : 'text-muted-foreground hover:text-sidebar-foreground',
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

<SettingsDialog bind:open={settingsOpen} />
