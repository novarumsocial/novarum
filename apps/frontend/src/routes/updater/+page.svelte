<!-- Launch splash for the desktop app, opened by apps/electron/src/main.ts before the main window -->
<script lang="ts">
  import favicon from '$lib/assets/favicon.svg';
  import { Progress } from '$lib/components/ui/progress/index.js';
  import type { UpdateStatus } from '$lib/electron-api';
  import { cn } from '$lib/utils';

  let update = $state<UpdateStatus>({ status: 'checking' });
  $effect(() => {
    void window.electron?.getUpdateStatus().then((status) => (update = status));
    return window.electron?.onUpdateStatus((status) => (update = status));
  });

  const message = $derived(
    {
      idle: 'Checking for updates',
      checking: 'Checking for updates',
      current: 'Starting Novarum',
      available: `Found version ${update.version}`,
      downloading: `Downloading version ${update.version}`,
      downloaded: 'Installing update',
      error: 'Starting Novarum',
      unsupported: 'Starting Novarum',
    }[update.status]
  );
</script>

<main
  class="flex h-svh flex-col items-center justify-center gap-6 bg-background px-8 text-foreground select-none [-webkit-app-region:drag]"
>
  <img src={favicon} alt="" class="size-16 invert dark:invert-0" />
  <div class="flex w-full flex-col items-center gap-3">
    <p class="font-heading text-lg font-medium tracking-tight">novarum</p>
    <p class="text-sm text-muted-foreground">{message}…</p>
    <Progress value={update.percent ?? 0} class={cn(update.status !== 'downloading' && 'invisible')} />
  </div>
</main>
