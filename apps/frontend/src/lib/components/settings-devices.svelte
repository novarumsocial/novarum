<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { LoaderCircle, RefreshCw, Smartphone } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { anchor } from '$lib/anchor.svelte';
  import { settings } from '$lib/settings.svelte';
  import { disablePush } from '$lib/push';
  import { formatDate } from '$lib/formatDate';
  import SettingsGroup from './settings-group.svelte';

  let { onOpenNotifications }: { onOpenNotifications: () => void } = $props();

  type Device = {
    id: string;
    kind: 'WEBPUSH' | 'UNIFIEDPUSH';
    host: string;
    createdAt: string;
    current: boolean;
  };

  let devices = $state<Device[]>([]);
  let loading = $state(true);
  let loadError = $state(false);
  let confirmingId = $state<string | null>(null);
  let removingId = $state<string | null>(null);
  let removeError = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const unifiedPushDevices = $derived(devices.filter((device) => device.kind === 'UNIFIEDPUSH'));

  async function load() {
    loading = true;
    loadError = false;
    const result = await anchor.client.notifications.subscriptions.get().catch(() => null);
    if (result?.data) devices = result.data.subscriptions;
    else loadError = true;
    loading = false;
  }

  function addedLabel(createdAt: string) {
    const date = formatDate(new Date(createdAt));
    return `Added ${date === 'Today' || date === 'Yesterday' ? date.toLowerCase() : date}`;
  }

  async function remove(device: Device) {
    removeError = null;
    clearTimeout(confirmTimer);
    if (confirmingId !== device.id) {
      confirmingId = device.id;
      confirmTimer = setTimeout(() => (confirmingId = null), 4000);
      return;
    }

    confirmingId = null;
    removingId = device.id;
    // this app would register itself again on its next start, so it stops asking for pushes too
    if (device.current) {
      settings.value.pushNotifications = false;
      await disablePush();
      devices = devices.filter((item) => item.id !== device.id);
    } else {
      const result = await anchor.client.notifications
        .subscriptions({ id: device.id })
        .delete()
        .catch(() => null);
      if (result?.data || result?.status === 404)
        devices = devices.filter((item) => item.id !== device.id);
      else removeError = `Couldn't remove ${device.host}. Check your connection and try again.`;
    }
    removingId = null;
  }

  onMount(() => {
    void load();
    return () => clearTimeout(confirmTimer);
  });
</script>

<SettingsGroup
  title="Push notifications"
  description="Remove a phone to stop its notifications. Signing out of it does the same."
>
  {#if loading}
    <div class="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
      <LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" />
      Loading devices…
    </div>
  {:else if loadError}
    <div class="flex items-center justify-between gap-4 px-4 py-4">
      <p class="text-sm text-muted-foreground">
        Couldn't load your devices. Check your connection and try again.
      </p>
      <Button variant="outline" size="sm" onclick={load}>
        <RefreshCw class="size-3.5" />
        Retry
      </Button>
    </div>
  {:else if unifiedPushDevices.length === 0}
    <div class="flex items-start gap-3 px-4 py-3.5">
      <div
        class="flex size-9 shrink-0 items-center justify-center border border-dashed border-muted-foreground/30 text-muted-foreground"
        class:rounded-full={settings.value.circleIcons}
      >
        <Smartphone class="size-4" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">No phones yet</p>
        <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          Turn on push notifications in the Android app, with a UnifiedPush distributor like ntfy.
        </p>
        <Button variant="outline" size="sm" class="mt-3" onclick={onOpenNotifications}>
          Notification settings
        </Button>
      </div>
    </div>
  {:else}
    {#each unifiedPushDevices as device (device.id)}
      {@const confirming = confirmingId === device.id}
      {@const removing = removingId === device.id}
      <div
        class="flex items-center gap-3 px-4 py-3.5"
        transition:slide={{ duration: reduceMotion ? 0 : 160 }}
      >
        <div
          class="flex size-9 shrink-0 items-center justify-center bg-muted text-muted-foreground"
          class:rounded-full={settings.value.circleIcons}
        >
          <Smartphone class="size-4" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-sm font-medium">
            <span class="truncate" title={device.host}>{device.host}</span>
            {#if device.current}
              <span class="shrink-0 bg-primary/30 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                This device
              </span>
            {/if}
          </p>
          <p class="mt-0.5 text-xs {confirming ? 'text-destructive' : 'text-muted-foreground'}">
            {#if confirming}
              {device.current
                ? 'Click again to remove. This also turns off push notifications here.'
                : 'Click again to remove. It stops getting notifications.'}
            {:else}
              {addedLabel(device.createdAt)}
            {/if}
          </p>
        </div>
        <Button
          variant={confirming ? 'destructive' : 'ghost'}
          size="sm"
          class="shrink-0"
          disabled={removing}
          aria-label={confirming ? `Confirm removing ${device.host}` : `Remove ${device.host}`}
          onclick={() => remove(device)}
        >
          {#if removing}
            <LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" />
            Removing
          {:else}
            {confirming ? 'Confirm remove' : 'Remove'}
          {/if}
        </Button>
      </div>
    {/each}
  {/if}
</SettingsGroup>

{#if removeError}
  <p class="text-xs text-destructive" aria-live="polite">{removeError}</p>
{/if}
