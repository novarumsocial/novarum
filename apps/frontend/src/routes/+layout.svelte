<script lang="ts">
  import './layout.css';
  import favicon from '$lib/assets/favicon.svg';
  import { settings } from '$lib/settings.svelte';
  let { children } = $props();

  $effect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', settings.value.darkMode);
    root.classList.toggle('light', !settings.value.darkMode);
    root.dataset.rounded = String(settings.value.circleIcons);
  });
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{@render children()}
