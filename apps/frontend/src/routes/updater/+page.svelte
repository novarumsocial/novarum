<!-- Launch splash for the desktop app, opened by apps/electron/src/main.ts before the main window -->
<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion, Tween } from 'svelte/motion';
  import type { UpdateStatus } from '$lib/electron-api';
  import { settings } from '$lib/settings.svelte';

  let update = $state<UpdateStatus>({ status: 'checking' });
  $effect(() => {
    // the main process reveals this window on the first status request, so ask once the theme is in
    void settings.ready
      .then(() => window.electron?.getUpdateStatus())
      .then((status) => status && (update = status));
    return window.electron?.onUpdateStatus((status) => (update = status));
  });

  // a faint novarum logo lights up as the update comes in: the ground lines from the middle out,
  // then the sun rises into place and its rays come out
  const pending = $derived(
    ['idle', 'checking', 'available', 'downloading'].includes(update.status)
  );
  const progress = Tween.of(
    () => (!pending ? 1 : update.status === 'downloading' ? (update.percent ?? 0) / 100 : 0),
    { duration: prefersReducedMotion.current ? 0 : 700, easing: cubicOut }
  );
  const lit = $derived(progress.current === 1);
  const checking = $derived(update.status === 'idle' || update.status === 'checking');
  const sun = 'M8 12a4 4 0 0 1 8 0';
  const ground = ['M2 16h20', 'M6 20h12'];
  const rays = [
    'M4 12h1',
    'M6.343 6.343l.707.707',
    'M12 4v1',
    'M17.657 6.343l-.707.707',
    'M20 12h-1',
  ];

  const status = $derived(
    {
      idle: ['Checking for updates', ''],
      checking: ['Checking for updates', ''],
      available: ['Update found', `Version ${update.version}`],
      downloading: [`Downloading version ${update.version}`, `${Math.round(update.percent ?? 0)}%`],
      downloaded: [`Installing version ${update.version}`, 'Novarum will reopen by itself'],
      current: ['Starting Novarum', ''],
      error: ['Starting Novarum', ''],
      unsupported: ['Starting Novarum', ''],
    }[update.status]
  );
</script>

<main
  class="flex h-svh flex-col items-center justify-center gap-7 border bg-background pb-4 text-foreground select-none [-webkit-app-region:drag]"
>
  <svg
    viewBox="0 0 24 24"
    class="size-28"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <g class="ghost" class:checking>
      {#each [sun, ...rays, ...ground] as d (d)}
        <path {d} />
      {/each}
    </g>
    {#each ground as d (d)}
      <path
        {d}
        pathLength="1"
        stroke-dasharray="{progress.current} 2"
        stroke-dashoffset={(progress.current - 1) / 2}
        opacity={progress.current > 0.01 ? 1 : 0}
      />
    {/each}
    <path d={sun} class="sun" class:lit />
    {#each rays as d, i (d)}
      <path {d} class="ray" class:lit style:transition-delay="{lit ? 200 + i * 70 : 0}ms" />
    {/each}
  </svg>

  <div class="flex flex-col items-center gap-1 text-center">
    <p class="text-sm font-medium">{status[0]}</p>
    <p class="min-h-4 text-xs text-muted-foreground tabular-nums">{status[1]}</p>
  </div>
</main>

<style>
  .ghost {
    opacity: 0.15;
  }

  .ghost.checking {
    animation: breathe 1.4s ease-in-out infinite alternate;
  }

  @keyframes breathe {
    to {
      opacity: 0.3;
    }
  }

  .sun,
  .ray {
    opacity: 0;
    transform-box: view-box;
    transform-origin: 12px 12px;
    transition:
      opacity 300ms ease-out,
      transform 500ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }

  .sun {
    transform: translateY(1.5px);
  }

  .ray {
    transform: scale(0.7);
  }

  .lit {
    opacity: 1;
    transform: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .ghost.checking {
      animation: none;
    }

    .sun,
    .ray {
      transition: none;
    }
  }
</style>
