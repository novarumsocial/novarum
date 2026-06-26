<script lang="ts">
  import { Mic, Headphones, Settings } from '@lucide/svelte';
  import SettingsDialog from './settings-dialog.svelte';

  type UserAreaUser = {
    username: string;
    displayName?: string | null;
    homeserver: string;
  };

  let { user }: { user: UserAreaUser } = $props();
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
      class="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-sidebar-foreground"
      aria-label="Mute"
    >
      <Mic class="size-4" />
    </button>
    <button
      class="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-sidebar-foreground"
      aria-label="Deafen"
    >
      <Headphones class="size-4" />
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
