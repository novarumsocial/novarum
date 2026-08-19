<script lang="ts">
  import './layout.css';
  import { browser } from '$app/environment';
  import favicon from '$lib/assets/favicon.svg';
  import { settings } from '$lib/settings.svelte';
  import { onMount } from 'svelte';
  import { Capacitor } from '@capacitor/core';
  import { checkForUpdates } from '$lib/ota';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';

  let { children } = $props();
  const desktop = browser && navigator.userAgent.includes('Electron');

  onMount(() => {
    if (Capacitor.isNativePlatform()) {
      void checkForUpdates();
    }
  });

  $effect(() => {
    const root = document.documentElement;
    root.classList.toggle('desktop', desktop);
    if (settings.value.darkMode) {
      root.classList.toggle('dark', true);
    } else {
      root.classList.remove('dark');
    }
    root.dataset.rounded = String(settings.value.circleIcons);
  });
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if desktop}
  <header class="desktop-titlebar" aria-hidden="true">
    <img src={favicon} alt="" />
    <span>novarum</span>
  </header>
{/if}

<Tooltip.Provider delayDuration={250}>
  {@render children()}
</Tooltip.Provider>
