<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { anchor } from '$lib/anchor.svelte';
  import { useSession } from '$lib/session.svelte';
  import { clearSignOn, pendingSignOn } from '$lib/sso.svelte';
  import { safeRedirect } from '$lib/safeRedirect';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import ConstellationBackground from '$lib/components/constellation-background.svelte';
  import { ArrowRight, AtSign, LoaderCircle, User } from '@lucide/svelte';

  const session = useSession();
  const code = page.url.searchParams.get('code');
  const pending = pendingSignOn();
  const next = safeRedirect(pending?.redirect ?? null);

  let error = $state(page.url.searchParams.get('error') ?? '');
  let signup = $state<{ provider: string; email: string | null } | null>(null);
  let username = $state('');
  let displayName = $state('');
  let loading = $state(false);

  onMount(async () => {
    if (error) return clearSignOn();
    if (!code || !pending) {
      error = 'This sign-in was started somewhere else. Start again from this app.';
      return;
    }

    const result = await session.finishSignOn(code, pending.verifier);
    if (!result.ok) {
      error = result.error;
      return clearSignOn();
    }
    if (result.result.status === 'signup') {
      signup = result.result;
      username = result.result.username ?? '';
      displayName = result.result.displayName ?? '';
      return;
    }
    clearSignOn();
    await goto(next);
  });

  async function createAccount(event: SubmitEvent) {
    event.preventDefault();
    if (!/^[a-zA-Z0-9._]{2,32}$/.test(username)) {
      error = 'Usernames are 2-32 letters, numbers, dots or underscores.';
      return;
    }
    loading = true;
    error = '';
    const result = await session.signOnSignup({
      code: code!,
      verifier: pending!.verifier,
      username,
      displayName: displayName.trim() || undefined,
    });
    loading = false;
    if (!result.ok) {
      error = result.error;
      return;
    }
    clearSignOn();
    await goto(next);
  }
</script>

<svelte:head>
  <title>novarum - signing in</title>
</svelte:head>

<div class="dark relative min-h-svh overflow-hidden bg-background">
  <ConstellationBackground class="absolute inset-0 h-full w-full" />

  <div class="relative flex min-h-svh items-center justify-center p-4 py-10">
    <Card.Root
      class="w-full max-w-md border-white/10 bg-card/70 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl"
    >
      {#if signup}
        <Card.Header class="text-center">
          <Card.Title class="text-xl">Pick your username</Card.Title>
          <Card.Description>
            You're new on {anchor.homeServer}. Your {signup.provider} account
            {signup.email ? `(${signup.email})` : ''} will sign you in from now on.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <form class="space-y-4" onsubmit={createAccount}>
            <div class="space-y-1.5">
              <Label for="sso-username">Username</Label>
              <div class="relative">
                <AtSign
                  class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="sso-username"
                  bind:value={username}
                  class="pl-8"
                  autocomplete="username"
                  autocapitalize="none"
                  spellcheck="false"
                  maxlength={32}
                />
              </div>
              <p class="text-xs text-muted-foreground">
                Handle preview:
                <span class="font-mono text-foreground"
                  >@{username || 'username'}:{anchor.homeServer}</span
                >
              </p>
            </div>
            <div class="space-y-1.5">
              <Label for="sso-display-name">
                Display name <span class="text-muted-foreground">(optional)</span>
              </Label>
              <div class="relative">
                <User
                  class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input id="sso-display-name" bind:value={displayName} class="pl-8" maxlength={64} />
              </div>
            </div>
            <Button type="submit" class="w-full" size="lg" disabled={loading}>
              {#if loading}
                <LoaderCircle class="size-4 animate-spin" />
                <span>Creating account…</span>
              {:else}
                <span>Create account</span>
                <ArrowRight class="size-4" />
              {/if}
            </Button>
            {#if error}
              <p class="text-sm text-destructive">{error}</p>
            {/if}
          </form>
        </Card.Content>
      {:else if error}
        <Card.Header class="text-center">
          <Card.Title class="text-xl">Could not sign you in</Card.Title>
          <Card.Description>{error}</Card.Description>
        </Card.Header>
        <Card.Footer class="justify-center">
          <Button href="/login" variant="outline">Back to sign in</Button>
        </Card.Footer>
      {:else}
        <Card.Content class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <LoaderCircle class="size-4 animate-spin" />
          <span class="text-sm">Signing you in…</span>
        </Card.Content>
      {/if}
    </Card.Root>
  </div>
</div>
