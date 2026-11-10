<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { Check, LoaderCircle, ShieldCheck, Lock } from '@lucide/svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import ConstellationBackground from '$lib/components/constellation-background.svelte';
  import Avatar from '$lib/components/avatar.svelte';
  import BotBadge from '$lib/components/bot-badge.svelte';
  import Markdown from '$lib/components/markdown.svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { useSession } from '$lib/session.svelte';
  import { addBotToGuild, lookupBot, parseBotHandle } from '$lib/bots.svelte';
  import type { PublicUser } from 'anchor/public-user';
  import Logo from '$lib/assets/favicon.svg';

  type Guild = { id: string; name: string; avatarUrl: string | null };

  const session = useSession();
  const handle = $derived(page.url.searchParams.get('bot') ?? '');
  const ref = $derived(parseBotHandle(handle));

  let loading = $state(true);
  let notFound = $state(false);
  let bot = $state<{ user: PublicUser; public: boolean } | null>(null);
  let guilds = $state<Guild[]>([]);
  let guildId = $state('');
  let role = $state<'MEMBER' | 'ADMIN'>('MEMBER');
  let adding = $state(false);
  let error = $state<string | null>(null);
  let added = $state(false);

  const name = $derived(bot ? bot.user.displayName || bot.user.username : '');
  const guild = $derived(guilds.find((g) => g.id === guildId));

  $effect(() => {
    role = page.url.searchParams.get('role') === 'ADMIN' ? 'ADMIN' : 'MEMBER';
  });

  $effect(() => {
    if (!session.initialized) return void session.refresh();
    if (!session.user) {
      void goto(`/login?redirect=${encodeURIComponent(page.url.pathname + page.url.search)}`);
      return;
    }
    void load();
  });

  async function load() {
    loading = true;
    if (!ref) {
      notFound = true;
      loading = false;
      return;
    }
    const [found, list] = await Promise.all([
      lookupBot(ref.username, ref.homeserver),
      anchor.client.guilds.list.get(),
    ]);
    bot = found;
    notFound = !found;
    guilds = list.data?.guilds ?? [];
    guildId = guilds[0]?.id ?? '';
    loading = false;
  }

  async function add() {
    if (!ref || !guildId) return;
    adding = true;
    error = await addBotToGuild(guildId, ref, role);
    adding = false;
    added = !error;
  }
</script>

<svelte:head>
  <title>novarum - add a bot</title>
</svelte:head>

<div class="dark relative min-h-svh overflow-hidden bg-background">
  <ConstellationBackground class="absolute inset-0 h-full w-full" />
  <a href="/guilds" class="absolute top-6 left-6 z-20 flex items-center gap-2.5 select-none">
    <span class="flex size-9 items-center justify-center bg-primary text-primary-foreground">
      <img src={Logo} alt="" class="absolute size-5" />
    </span>
    <span class="text-lg font-semibold tracking-tight">novarum</span>
  </a>

  <div class="relative flex min-h-svh items-center justify-center p-4">
    <Card.Root
      class="w-full max-w-md border-white/10 bg-card/80 shadow-2xl shadow-black/50 backdrop-blur-xl"
    >
      {#if loading}
        <Card.Content class="flex flex-col items-center gap-4 py-16">
          <LoaderCircle class="size-8 animate-spin text-muted-foreground" />
          <p class="text-sm text-muted-foreground">Looking up the bot…</p>
        </Card.Content>
      {:else if notFound || !bot}
        <Card.Header>
          <Card.Title class="text-xl">Bot not found</Card.Title>
          <Card.Description>
            {handle
              ? `There's no bot called ${handle}. Check the link with whoever sent it.`
              : 'This link is missing the bot it should add.'}
          </Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button variant="outline" href="/guilds">Back to Novarum</Button>
        </Card.Footer>
      {:else if added && guild}
        <Card.Header class="items-center text-center">
          <span
            class="mx-auto flex size-10 items-center justify-center bg-emerald-500/15 text-emerald-500"
          >
            <Check class="size-5" />
          </span>
          <Card.Title class="mt-2 text-xl">{name} is in {guild.name}</Card.Title>
          <Card.Description>Try typing / in a channel to see what it can do.</Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button class="w-full" href={`/guilds/${encodeURIComponent(guild.id)}`}>
            Go to {guild.name}
          </Button>
        </Card.Footer>
      {:else}
        <Card.Header>
          <div class="flex items-center gap-3">
            <Avatar
              src={bot.user.avatarUrl}
              {name}
              class="size-12 text-sm"
              bgColor={bot.user.avatarColor}
            />
            <div class="min-w-0">
              <Card.Title class="flex items-center gap-2 text-lg">
                <span class="truncate">{name}</span>
                <BotBadge />
              </Card.Title>
              <Card.Description class="truncate font-mono text-xs"
                >@{bot.user.username}:{bot.user.homeserver}</Card.Description
              >
            </div>
          </div>
          {#if bot.user.about}
            <div class="mt-3 line-clamp-4 text-sm text-foreground/80">
              <Markdown content={bot.user.about} links compact />
            </div>
          {/if}
        </Card.Header>

        <Card.Content class="space-y-5">
          {#if !bot.public}
            <p
              class="flex gap-2 border-l-2 border-amber-500 pl-3 text-xs leading-5 text-muted-foreground"
            >
              <Lock class="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              This bot is private. Only the person who made it can add it to guilds.
            </p>
          {/if}

          <div class="grid gap-2">
            <Label>Add it to</Label>
            {#if guilds.length === 0}
              <p class="text-sm text-muted-foreground">You aren't in any guilds yet.</p>
            {:else}
              <RadioGroup.Root bind:value={guildId} class="max-h-60 gap-0 overflow-y-auto border">
                {#each guilds as item (item.id)}
                  <Label
                    class="flex cursor-pointer items-center gap-3 border-b px-3 py-2 font-normal last:border-b-0 hover:bg-muted/40 has-data-[state=checked]:bg-primary/10"
                  >
                    <RadioGroup.Item value={item.id} />
                    <Avatar src={item.avatarUrl} name={item.name} class="size-7 text-[10px]" />
                    <span class="truncate text-sm">{item.name}</span>
                  </Label>
                {/each}
              </RadioGroup.Root>
            {/if}
          </div>

          <div class="grid gap-2">
            <Label>As</Label>
            <RadioGroup.Root
              value={role}
              onValueChange={(value) => (role = value === 'ADMIN' ? 'ADMIN' : 'MEMBER')}
              class="gap-2"
            >
              <Label class="flex cursor-pointer items-start gap-3 font-normal">
                <RadioGroup.Item value="MEMBER" class="mt-0.5" />
                <span>
                  <span class="block text-sm">Member</span>
                  <span class="block text-xs text-muted-foreground"
                    >Reads and sends messages like everyone else.</span
                  >
                </span>
              </Label>
              <Label class="flex cursor-pointer items-start gap-3 font-normal">
                <RadioGroup.Item value="ADMIN" class="mt-0.5" />
                <span>
                  <span class="block text-sm">Admin</span>
                  <span class="block text-xs text-muted-foreground"
                    >Also manages channels and posts in owner-only channels. Guild owners only.</span
                  >
                </span>
              </Label>
            </RadioGroup.Root>
          </div>

          {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
        </Card.Content>

        <Card.Footer class="flex-col gap-3">
          <Button class="w-full" size="lg" disabled={!guildId || adding} onclick={add}>
            {#if adding}
              <LoaderCircle class="size-4 animate-spin" />
              Adding…
            {:else}
              <ShieldCheck class="size-4" />
              Add {name}{guild ? ` to ${guild.name}` : ''}
            {/if}
          </Button>
          <p class="text-center text-xs text-muted-foreground">
            {name} will see the messages in every channel of the guild.
          </p>
        </Card.Footer>
      {/if}
    </Card.Root>
  </div>
</div>
