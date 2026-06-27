<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { anchor } from '$lib/anchor.svelte';
  import { createAnchorClient, discoverAnchor, normalizeHomeServer } from '$lib/api';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import {
    MessagesSquare,
    Users,
    LoaderCircle,
    Copy,
    Check,
    Hash,
    ArrowRight,
  } from '@lucide/svelte';
  import ConstellationBackground from '$lib/components/constellation-background.svelte';

  type InviteState = {
    invite: {
      id: string;
      code: string;
      guildId: string;
      creatorId: string;
      createdAt: Date | string;
      expiresAt: Date | string | null;
    };
    guild: {
      id: string;
      name: string;
      description: string | null;
      avatarUrl: string | null;
      memberCount: number;
    };
  };

  const raw = $derived(decodeInviteParam(page.params.code ?? ''));
  const atIdx = $derived(raw.lastIndexOf('@'));
  const rawInviteCode = $derived(atIdx !== -1 ? raw.slice(0, atIdx) : raw);
  const inviteCode = $derived(
    rawInviteCode.startsWith('$') ? rawInviteCode.slice(1) : rawInviteCode
  );
  const homeServer = $derived(atIdx !== -1 ? raw.slice(atIdx + 1) : raw);
  const normalizedHomeServer = $derived(normalizeHomeServer(homeServer));

  let loading = $state(true);
  let accepting = $state(false);
  let error = $state('');
  let invite = $state<InviteState | null>(null);
  let accepted = $state(false);
  let copied = $state(false);
  let userHomeServer = $state(anchor.homeServer);

  const inviteUrl = $derived(`${window.location.origin}/i/${raw}`);

  $effect(() => {
    if (inviteCode && homeServer) lookupInvite();
  });

  async function lookupInvite() {
    let inviteClient: ReturnType<typeof createAnchorClient>;

    try {
      inviteClient = createAnchorClient(await discoverAnchor(normalizedHomeServer));
    } catch {
      error = 'Could not discover this home server.';
      loading = false;
      return;
    }

    const result = await inviteClient.invite({ code: inviteCode }).get();

    if (result.error || !result.data || 'error' in result.data) {
      error = 'This invite is invalid or has expired.';
      loading = false;
      return;
    }

    invite = result.data;
    loading = false;
  }

  async function acceptInvite() {
    accepting = true;
    error = '';
    const remoteInvite = normalizedHomeServer !== userHomeServer;

    if (remoteInvite) {
      try {
        await anchor.setHomeServer(userHomeServer);
      } catch {
        error = 'Could not discover your home server.';
        accepting = false;
        return;
      }
    }

    const result = await anchor.client.invite.accept.post({
      code: inviteCode,
      ...(remoteInvite ? { homeserver: normalizedHomeServer } : {}),
    });
    const data = result.data as
      | { error?: string; guildId?: string; guild?: { id: string } }
      | null
      | undefined;

    if (result.error || !data || data.error) {
      const status =
        result.error && typeof result.error === 'object' && 'status' in result.error
          ? Number(result.error.status)
          : undefined;
      const errorValue =
        result.error && typeof result.error === 'object' && 'value' in result.error
          ? result.error.value
          : undefined;
      const err = data?.error
        ? String(data.error)
        : errorValue && typeof errorValue === 'object' && 'error' in errorValue
          ? String(errorValue.error)
          : 'Could not accept invite.';

      if (
        status === 401 ||
        err.toLowerCase().includes('unauthorized') ||
        err.toLowerCase().includes('not authenticated') ||
        err.toLowerCase().includes('no session')
      ) {
        await goto(`/login?redirect=${encodeURIComponent(`/i/${raw}`)}`);
        return;
      }

      error = err;
      accepting = false;
      return;
    }

    accepted = true;
    const guildId = data.guildId ?? data.guild?.id;
    await goto(guildId ? `/guilds/${guildId}` : '/guilds');
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl);
    copied = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    copied = false;
  }

  function decodeInviteParam(value: string) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
</script>

<svelte:head>
  <title>novarum - join server</title>
  <meta name="description" content="Join a server on novarum" />
</svelte:head>

<div class="dark relative min-h-svh overflow-hidden bg-background">
  <ConstellationBackground class="absolute inset-0 h-full w-full" />

  <div
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(130,175,235,0.10),transparent_58%)]"
  ></div>
  <div
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.6)_100%)]"
  ></div>

  <div class="relative flex min-h-svh items-center justify-center p-4">
    {#if loading}
      <Card.Root
        class="w-full max-w-md border-white/10 bg-card/70 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl"
      >
        <Card.Content class="py-16">
          <div class="flex flex-col items-center gap-4">
            <LoaderCircle class="size-8 animate-spin text-muted-foreground" />
            <p class="text-sm text-muted-foreground">Looking up invite…</p>
          </div>
        </Card.Content>
      </Card.Root>
    {:else if accepted}
      <Card.Root
        class="w-full max-w-md border-white/10 bg-card/70 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl"
      >
        <Card.Header class="space-y-3">
          <div class="flex items-center gap-2.5">
            <div class="flex size-9 items-center justify-center bg-primary text-primary-foreground">
              <MessagesSquare class="size-5" />
            </div>
            <span class="text-lg font-semibold tracking-tight">novarum</span>
          </div>
          <Card.Title class="text-xl">You joined the server!</Card.Title>
          <Card.Description>
            Redirecting you to {invite?.guild.name ?? 'the server'}…
          </Card.Description>
        </Card.Header>
      </Card.Root>
    {:else if error}
      <Card.Root
        class="w-full max-w-md border-white/10 bg-card/70 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl"
      >
        <Card.Header class="space-y-3">
          <div class="flex items-center gap-2.5">
            <div class="flex size-9 items-center justify-center bg-primary text-primary-foreground">
              <MessagesSquare class="size-5" />
            </div>
            <span class="text-lg font-semibold tracking-tight">novarum</span>
          </div>
          <Card.Title class="text-xl">Invite not found</Card.Title>
          <Card.Description>{error}</Card.Description>
        </Card.Header>

        <Card.Content class="space-y-4">
          <p class="text-sm text-muted-foreground">
            The invite link you're trying to use may have expired or is invalid. Ask the server
            owner for a new one.
          </p>

          <div
            class="flex items-center gap-2 rounded-sm border border-border bg-muted/50 px-3 py-2"
          >
            <Hash class="size-4 shrink-0 text-muted-foreground" />
            <code class="flex-1 truncate font-mono text-xs text-muted-foreground">{inviteUrl}</code>
          </div>
        </Card.Content>

        <Card.Footer class="justify-center text-xs text-muted-foreground">
          <span>Want to start your own?</span>
          <a
            href="/register"
            class="ml-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline"
            >Create an account</a
          >
        </Card.Footer>
      </Card.Root>
    {:else if invite}
      <Card.Root
        class="w-full max-w-md border-white/10 bg-card/70 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl"
      >
        <Card.Header class="space-y-3">
          <div class="flex items-center gap-2.5">
            <div class="flex size-9 items-center justify-center bg-primary text-primary-foreground">
              <MessagesSquare class="size-5" />
            </div>
            <span class="text-lg font-semibold tracking-tight">novarum</span>
          </div>
          <div class="space-y-1">
            <Card.Title class="text-xl">You're invited!</Card.Title>
            <Card.Description>Join your friends on a shared server.</Card.Description>
          </div>
        </Card.Header>

        <Card.Content class="space-y-5">
          <div
            class="flex items-center gap-4 rounded-sm border border-border bg-muted/30 px-4 py-3"
          >
            <div
              class="flex size-10 shrink-0 items-center justify-center bg-primary/20 text-primary"
            >
              <Hash class="size-5" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{invite.guild.name}</p>
              <p class="flex items-center gap-1 text-xs text-muted-foreground">
                <Users class="size-3" />
                <span
                  >{invite.guild.memberCount} member{invite.guild.memberCount !== 1
                    ? 's'
                    : ''}</span
                >
                <span class="mx-1">·</span>
                <span>@{homeServer}</span>
              </p>
            </div>
          </div>

          <div class="grid gap-1.5">
            <label for="invite-link" class="text-xs font-medium text-foreground">
              Invite Link
            </label>
            <div class="flex gap-2">
              <Input id="invite-link" value={inviteUrl} readonly class="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy invite link"
                onclick={copyInvite}
              >
                {#if copied}
                  <Check class="size-4" />
                {:else}
                  <Copy class="size-4" />
                {/if}
              </Button>
            </div>
          </div>

          <Button class="w-full" size="lg" disabled={accepting} onclick={acceptInvite}>
            {#if accepting}
              <LoaderCircle class="size-4 animate-spin" />
              <span>Joining…</span>
            {:else}
              <span>Accept Invite</span>
              <ArrowRight class="size-4" />
            {/if}
          </Button>

          {#if error}
            <p class="text-sm text-destructive">{error}</p>
          {/if}
        </Card.Content>

        <Card.Footer class="justify-center text-xs text-muted-foreground">
          <span>Not {homeServer}?</span>
          <button
            type="button"
            class="ml-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline"
          >
            Sign in with a different account
          </button>
        </Card.Footer>
      </Card.Root>
    {/if}
  </div>
</div>
