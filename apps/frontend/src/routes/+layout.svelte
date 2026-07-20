<script lang="ts">
  import './layout.css';
  import favicon from '$lib/assets/favicon.svg';
  import { settings } from '$lib/settings.svelte';
  let { children } = $props();

  $effect(() => {
    const root = document.documentElement;
    // commenting willysuna's logic here because i think the if statement fits better
    // i've also removed the `.light` class toggle to resemble a bit more the shadcn-ui way of thinking about light and dark mode toggles.
    // root.classList.toggle('dark', settings.value.darkMode);
    // root.classList.toggle('light', !settings.value.darkMode);
    if (settings.value.darkMode) {
      root.classList.toggle('dark', true);
    } else {
      root.classList.remove('dark');
    }
    root.dataset.rounded = String(settings.value.circleIcons);
  });
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{@render children()}
