<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { Mic, Headphones, Settings } from '@lucide/svelte';
  import SettingsDialog from './settings-dialog.svelte';

  type MeData = Awaited<ReturnType<typeof anchor.client.auth.me.get>>['data'];

  let data = $state<MeData | null>(null);
  let loading = $state(true);
  let settingsOpen = $state(false);

  onMount(async () => {
    const result = await anchor.client.auth.me.get();
    data = result.data;
    loading = false;

    if (!data) {
      await goto('/login');
    }
  });
</script>

<div
  class="flex h-14 shrink-0 items-center gap-2.5 border-t border-border bg-sidebar-accent/30 px-3"
>
  <div
    class="flex size-8 shrink-0 items-center justify-center bg-primary/20 text-xs font-bold text-primary"
  >
    {data?.user.username.slice(0, 1).toUpperCase() || '?'}
  </div>
  <div class="min-w-0 flex-1">
    {#if loading}
      <p class="truncate text-sm font-medium leading-tight text-sidebar-foreground">Loading…</p>
      <p class="truncate text-[11px] text-muted-foreground">Checking session</p>
    {:else}
      <p class="truncate text-sm font-medium leading-tight text-sidebar-foreground">
        {data?.user.displayName || data?.user.username}
      </p>
      <p class="truncate text-[11px] text-muted-foreground">
        @{data?.user.username}@{data?.user.homeserver}
      </p>
    {/if}
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
