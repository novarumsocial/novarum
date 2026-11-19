<!-- Launch splash for the desktop app, opened by apps/electron/src/main.ts before the main window -->
<script lang="ts">
  import type { UpdateStatus } from '$lib/electron-api';

  let update = $state<UpdateStatus>({ status: 'checking' });
  $effect(() => {
    void window.electron?.getUpdateStatus().then((status) => (update = status));
    return window.electron?.onUpdateStatus((status) => (update = status));
  });

  // the logo's sun rises over its horizon as the update downloads; the horizon is the progress bar
  const progress = $derived(
    update.status === 'downloading'
      ? (update.percent ?? 0) / 100
      : update.status === 'checking' || update.status === 'idle' || update.status === 'available'
        ? 0
        : 1
  );
  const rise = $derived(30 * (1 - progress));
  const message = $derived(
    {
      idle: 'Checking for updates…',
      checking: 'Checking for updates…',
      available: `Found version ${update.version}`,
      downloading: `Downloading version ${update.version}…`,
      downloaded: `Installing version ${update.version}…`,
      current: 'Starting Novarum…',
      error: 'Starting Novarum…',
      unsupported: 'Starting Novarum…',
    }[update.status]
  );
</script>

<main
  class="flex h-svh flex-col justify-between bg-background pb-7 text-foreground select-none [-webkit-app-region:drag]"
>
  <svg viewBox="0 0 300 200" class="w-full" aria-hidden="true">
    <clipPath id="sky"><rect width="300" height="144" /></clipPath>
    <g
      clip-path="url(#sky)"
      stroke="currentColor"
      stroke-width="8"
      stroke-linecap="round"
      fill="none"
    >
      <g
        class="transition-transform duration-500 ease-out motion-reduce:transition-none"
        style:transform="translateY({rise}px)"
      >
        <path d="M126 126a24 24 0 0 1 48 0" />
        <g
          class={['transition-opacity duration-500', progress === 0 && 'motion-safe:animate-pulse']}
          opacity={Math.max(0.25, 1 - rise / 30)}
        >
          <path d="M150 78v6M102 126h6M192 126h6M116 92l4 4M184 92l-4 4" />
        </g>
      </g>
    </g>
    <g stroke-width="8" stroke-linecap="round">
      <path d="M24 150h252" class="stroke-muted" />
      <path
        d="M24 150h252"
        pathLength="1"
        stroke-dasharray="1"
        stroke-dashoffset={1 - progress}
        class={[
          'stroke-primary transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none',
          progress === 0 && 'invisible',
        ]}
      />
      <path d="M114 174h72" class="stroke-muted" />
    </g>
  </svg>

  <div class="px-6">
    <p class="text-[15px] font-medium tracking-tight">novarum</p>
    <div class="flex items-baseline justify-between gap-4 text-[13px] text-muted-foreground">
      <p class="truncate">{message}</p>
      {#if update.status === 'downloading'}
        <p class="tabular-nums">{Math.round(update.percent ?? 0)}%</p>
      {/if}
    </div>
  </div>
</main>
