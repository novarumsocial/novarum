<script lang="ts">
  import { fade } from 'svelte/transition';

  let { finished = false }: { finished?: boolean } = $props();
</script>

<main
  transition:fade={{ duration: 100 }}
  class="relative flex h-svh items-center justify-center overflow-hidden bg-background px-6 text-foreground"
>
  <div
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_30rem)]"
  ></div>

  <div
    class="relative flex w-full max-w-56 flex-col items-center text-center"
    role="status"
    aria-label={finished ? 'Ready' : 'Loading your guilds'}
  >
    <svg
      viewBox="0 0 24 24"
      class="size-36 overflow-visible text-primary drop-shadow-[0_0_2rem_color-mix(in_oklab,var(--primary)_30%,transparent)]"
      aria-hidden="true"
    >
      <defs>
        <clipPath id="sunrise-clip">
          <rect width="24" height="15" />
        </clipPath>
      </defs>

      <g clip-path="url(#sunrise-clip)">
        <g class:finished class="sun" fill="currentColor">
          <path d="M7 12a1 1 0 0 0 2 0 3 3 0 0 1 6 0 1 1 0 0 0 2 0 5 5 0 0 0-10 0Z" />
          <path d="M11 5a1 1 0 0 0 2 0V4a1 1 0 0 0-2 0Z" />
          <path d="M18 12a1 1 0 0 0 1 1h1a1 1 0 0 0 0-2h-1a1 1 0 0 0-1 1Z" />
          <path d="M3 12a1 1 0 0 0 1 1h1a1 1 0 0 0 0-2H4a1 1 0 0 0-1 1Z" />
          <path
            d="M5.636 5.636a1 1 0 0 0 0 1.414l.707.707a1 1 0 0 0 1.414-1.414l-.707-.707a1 1 0 0 0-1.414 0Z"
          />
          <path d="m16.95 5.636-.707.707a1 1 0 1 0 1.414 1.414l.707-.707a1 1 0 1 0-1.414-1.414Z" />
        </g>
      </g>

      <path fill="currentColor" d="M2 15a1 1 0 0 0 0 2h20a1 1 0 0 0 0-2Z" />
      <path fill="currentColor" d="M6 19a1 1 0 0 0 0 2h12a1 1 0 0 0 0-2Z" />
    </svg>

    <div class="mt-8">
      <h1 class="text-xl font-semibold tracking-tight">novarum</h1>
    </div>
  </div>
</main>

<style>
  .sun {
    transform-box: view-box;
    transform-origin: 12px 10px;
    animation: loading 0.8s ease-out both;
  }

  .sun.finished {
    animation: finished 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes loading {
    from {
      transform: translateY(9px);
    }
    to {
      transform: translateY(4px);
    }
  }

  @keyframes finished {
    0% {
      transform: translateY(4px);
    }
    100% {
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sun,
    .sun.finished {
      animation: none;
    }
  }
</style>
