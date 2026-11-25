<script lang="ts">
  import { anchor } from '$lib/anchor.svelte';
  import type { AnchorAuthInfo } from '$lib/api';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { signOnSupported, startSignOn } from '$lib/sso.svelte';
  import { KeyRound, LoaderCircle } from '@lucide/svelte';

  let {
    homeServer,
    providers,
    redirect,
  }: { homeServer: string; providers: AnchorAuthInfo['providers']; redirect?: string } = $props();

  let pending = $state<string | null>(null);
  let error = $state('');

  async function signOn(provider: string) {
    pending = provider;
    error = '';
    try {
      await anchor.setHomeServer(homeServer);
      error = (await startSignOn(provider, { redirect })) ?? '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not reach that server.';
    }
    pending = null;
  }
</script>

{#if signOnSupported && providers.length}
  <div class="my-5 flex items-center gap-3">
    <Separator class="flex-1" />
    <span class="text-xs text-muted-foreground">or</span>
    <Separator class="flex-1" />
  </div>

  <div class="space-y-2">
    {#each providers as provider (provider.id)}
      <Button
        type="button"
        variant="outline"
        class="w-full"
        size="lg"
        disabled={pending !== null}
        onclick={() => signOn(provider.id)}
      >
        {#if pending === provider.id}
          <LoaderCircle class="size-4 animate-spin" />
        {:else}
          <KeyRound class="size-4" />
        {/if}
        Continue with {provider.name}
      </Button>
    {/each}
    {#if error}
      <p class="text-sm text-destructive">{error}</p>
    {/if}
  </div>
{/if}
