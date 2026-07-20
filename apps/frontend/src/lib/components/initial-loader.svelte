<script lang="ts">
  import { fade } from 'svelte/transition';
</script>

<main
  transition:fade={{ duration: 100 }}
  class="flex h-svh items-center justify-center overflow-hidden bg-background text-foreground"
>
  <!-- Radial gradient background layers -->
  <div
    class="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_center,rgba(130,175,235,0.10),transparent_58%)]"
  ></div>
  <div
    class="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.6)_100%)]"
  ></div>

  <!-- Glass card -->
  <div
    class="relative z-10 flex w-80 flex-col items-center gap-7 bg-card/70 px-10 py-14 text-center ring-1 ring-white/5 shadow-2xl shadow-black/50 backdrop-blur-xl"
  >
    <!-- Brand mark -->
    <div
      class="grid size-14 place-items-center bg-primary text-lg font-bold text-primary-foreground"
      aria-hidden="true"
    >
      N
    </div>

    <!-- Copy -->
    <div class="space-y-2">
      <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Novarum
      </p>
      <h1 class="text-sm font-semibold tracking-tight">Warming up your guilds</h1>
    </div>
  </div>
</main>
