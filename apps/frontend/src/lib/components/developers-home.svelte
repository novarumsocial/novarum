<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    Bot,
    Camera,
    Check,
    Copy,
    KeyRound,
    LoaderCircle,
    Menu,
    Plus,
    SquareSlash,
    Trash2,
    UserPlus,
    Settings2,
  } from '@lucide/svelte';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { anchor } from '$lib/anchor.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { developers, type DeveloperBot } from '$lib/bots.svelte';
  import { cn } from '$lib/utils';
  import Avatar from './avatar.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';
  import BotBadge from './bot-badge.svelte';

  let { onOpenNavigation }: { onOpenNavigation: () => void } = $props();

  const selectedId = $derived(chat.route.kind === 'developers' ? chat.route.botId : null);
  const selected = $derived(developers.find(selectedId));
  const open = (id: string | null) =>
    goto(id ? `/guilds/developers/${encodeURIComponent(id)}` : '/guilds/developers');

  $effect(() => {
    if (!developers.loaded && !developers.loading) void developers.load();
  });

  // ---- creating ----------------------------------------------------------------------------------

  let createOpen = $state(false);
  let newUsername = $state('');
  let newDisplayName = $state('');
  let creating = $state(false);
  let createError = $state<string | null>(null);

  async function create(event: SubmitEvent) {
    event.preventDefault();
    creating = true;
    createError = null;
    const result = await developers.create(newUsername.trim(), newDisplayName.trim());
    creating = false;
    if (!result.ok) return void (createError = result.error);
    createOpen = false;
    newUsername = '';
    newDisplayName = '';
    tab = 'token';
    await open(result.bot.userId);
  }

  // ---- the selected bot --------------------------------------------------------------------------

  let tab = $state<'general' | 'token' | 'commands' | 'install'>('general');
  let displayName = $state('');
  let about = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let saved = $state(false);

  // the form follows the bot you pick
  $effect(() => {
    displayName = selected?.displayName ?? '';
    about = selected?.about ?? '';
    saveError = null;
    saved = false;
  });

  async function saveProfile(event: SubmitEvent) {
    event.preventDefault();
    if (!selected) return;
    saving = true;
    saveError = await developers.update(selected.userId, {
      displayName: displayName.trim() || null,
      about: about.trim() || null,
    });
    saving = false;
    saved = !saveError;
  }

  async function setPublic(bot: DeveloperBot, isPublic: boolean) {
    saveError = await developers.update(bot.userId, { public: isPublic });
  }

  let fileInput = $state<HTMLInputElement | null>(null);
  let cropFile = $state<File | null>(null);
  let cropOpen = $state(false);
  let uploading = $state(false);

  function pickAvatar(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.type === 'image/gif') return void uploadAvatar(file);
    cropFile = file;
    cropOpen = true;
  }

  async function uploadAvatar(blob: Blob) {
    if (!selected) return;
    uploading = true;
    const type = blob.type === 'image/gif' ? 'image/gif' : 'image/png';
    saveError = await developers.uploadAvatar(
      selected.userId,
      new File([blob], `avatar.${type === 'image/gif' ? 'gif' : 'png'}`, { type })
    );
    uploading = false;
  }

  // ---- token -------------------------------------------------------------------------------------

  let resetOpen = $state(false);
  let resetting = $state(false);
  let tokenError = $state<string | null>(null);
  const revealed = $derived(
    developers.revealedToken?.botId === selectedId ? developers.revealedToken.token : null
  );

  async function resetToken() {
    if (!selected) return;
    resetting = true;
    tokenError = await developers.regenerateToken(selected.userId);
    resetting = false;
    resetOpen = false;
  }

  let copied = $state<string | null>(null);
  async function copy(what: string, text: string) {
    await navigator.clipboard.writeText(text);
    copied = what;
    setTimeout(() => (copied = copied === what ? null : copied), 1500);
  }

  // ---- installing --------------------------------------------------------------------------------

  let installRole = $state<'MEMBER' | 'ADMIN'>('MEMBER');
  const installUrl = $derived(
    selected
      ? `${window.location.origin}/authorize?bot=${encodeURIComponent(selected.handle)}${installRole === 'ADMIN' ? '&role=ADMIN' : ''}`
      : ''
  );

  // ---- deleting ----------------------------------------------------------------------------------

  let deleteOpen = $state(false);
  let deleteConfirm = $state('');
  let deleting = $state(false);

  async function deleteBot() {
    if (!selected) return;
    deleting = true;
    saveError = await developers.remove(selected.userId);
    deleting = false;
    deleteOpen = false;
    deleteConfirm = '';
    if (!saveError) await open(null);
  }

  // the quickstart uses this homeserver and, right after it was made, the real token
  const quickstart = $derived(`import { Client } from '@novarum/sdk';

const client = new Client({
  token: process.env.BOT_TOKEN!,
  baseUrl: '${anchor.baseUrl}',
});

client.on('messageCreate', async (message) => {
  if (message.content === '!ping') await message.reply('Pong!');
});

await client.login();
console.log(\`Logged in as \${client.user!.tag}\`);`);

  const tabs = [
    { value: 'general', label: 'General', icon: Settings2 },
    { value: 'token', label: 'Token', icon: KeyRound },
    { value: 'commands', label: 'Commands', icon: SquareSlash },
    { value: 'install', label: 'Add to a guild', icon: UserPlus },
  ] as const;
</script>

{#snippet code(text: string, label: string)}
  <div class="relative border bg-sidebar">
    <Button
      variant="ghost"
      size="icon-sm"
      class="absolute top-1.5 right-1.5 bg-sidebar"
      aria-label="Copy {label}"
      onclick={() => copy(label, text)}
    >
      {#if copied === label}<Check class="size-3.5" />{:else}<Copy class="size-3.5" />{/if}
    </Button>
    <pre class="overflow-x-auto p-3 pr-12 font-mono text-xs leading-5"><code>{text}</code></pre>
  </div>
{/snippet}

{#snippet quickstartPanel()}
  <section class="max-w-2xl">
    <h2 class="text-base font-semibold">Run your bot</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      Install the SDK, {revealed ? 'put the token in a .env file next to it, ' : ''}paste this into
      <code class="font-mono text-xs">bot.ts</code>
      and run it with
      <code class="font-mono text-xs">bun bot.ts</code>.
    </p>
    <div class="mt-4 space-y-2">
      {@render code('bun add @novarum/sdk', 'install command')}
      {#if revealed}{@render code(`BOT_TOKEN=${revealed}`, '.env')}{/if}
      {@render code(quickstart, 'quickstart')}
    </div>
    <p class="mt-3 text-xs text-muted-foreground">
      More in the <a
        href="https://novarum.me/bots/getting-started/"
        target="_blank"
        rel="noopener noreferrer"
        class="text-link hover:underline">bot guide</a
      >.
    </p>
  </section>
{/snippet}

<main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
  <header class="flex h-12 shrink-0 items-center gap-4 border-b px-4">
    <Button
      variant="ghost"
      size="icon-sm"
      class="md:hidden"
      onclick={onOpenNavigation}
      aria-label="Open navigation"
    >
      <Menu class="size-5" />
    </Button>
    <div class="flex items-center gap-2 text-sm font-semibold">
      <Bot class="size-5 text-muted-foreground" />
      Developers
    </div>
    <Button size="sm" class="ml-auto" onclick={() => (createOpen = true)}>
      <Plus class="size-3.5" />
      New bot
    </Button>
  </header>

  <div class="flex min-h-0 flex-1">
    <!-- your bots -->
    <nav
      class={cn(
        'w-full shrink-0 overflow-y-auto border-r p-2 md:w-64',
        selectedId && 'hidden md:block'
      )}
      aria-label="Your bots"
    >
      {#if developers.loading && !developers.loaded}
        <p class="px-2 py-6 text-sm text-muted-foreground">Loading your bots…</p>
      {:else if developers.bots.length === 0}
        <p class="px-2 py-6 text-sm leading-6 text-muted-foreground">Bots you make show up here.</p>
      {/if}
      {#each developers.bots as bot (bot.userId)}
        {@const name = bot.displayName || bot.username}
        <button
          type="button"
          class={cn(
            'flex w-full items-center gap-2.5 px-2 py-2 text-left hover:bg-card',
            bot.userId === selectedId && 'bg-primary/10'
          )}
          aria-current={bot.userId === selectedId ? 'page' : undefined}
          onclick={() => {
            tab = 'general';
            void open(bot.userId);
          }}
        >
          <Avatar src={bot.avatarUrl} {name} class="size-8 text-xs" bgColor={bot.avatarColor} />
          <span class="min-w-0 flex-1 leading-tight">
            <span class="block truncate text-sm font-medium">{name}</span>
            <span class="block truncate text-xs text-muted-foreground">
              {bot.guildCount}
              {bot.guildCount === 1 ? 'guild' : 'guilds'}
            </span>
          </span>
        </button>
      {/each}
      {#if developers.error}
        <p class="mt-2 border-l-2 border-destructive pl-2 text-xs text-destructive">
          {developers.error}
        </p>
      {/if}
    </nav>

    <section class={cn('min-w-0 flex-1 overflow-y-auto', !selectedId && 'hidden md:block')}>
      {#if !selected}
        <div class="px-4 py-8 sm:px-8">
          {#if developers.loaded && developers.bots.length === 0}
            <div class="mb-10 max-w-2xl">
              <h1 class="text-xl font-semibold">Make a bot for Novarum</h1>
              <p class="mt-2 text-sm leading-6 text-muted-foreground">
                A bot is an account your code controls. It can read and send messages in the guilds
                it is added to, register slash commands and answer with embeds and buttons.
              </p>
              <Button class="mt-4" onclick={() => (createOpen = true)}>
                <Plus class="size-3.5" />
                Make your first bot
              </Button>
            </div>
          {:else if developers.loaded}
            <p class="mb-10 text-sm text-muted-foreground">Pick a bot to manage it.</p>
          {/if}
          {@render quickstartPanel()}
        </div>
      {:else}
        {@const name = selected.displayName || selected.username}
        <div class="border-b px-4 pt-6 sm:px-8">
          <Button variant="ghost" size="sm" class="-ml-2 mb-3 md:hidden" onclick={() => open(null)}
            >All bots</Button
          >
          <div class="flex items-center gap-4">
            <div class="group relative size-16 shrink-0 overflow-hidden">
              <Avatar
                src={selected.avatarUrl}
                {name}
                class="size-16 text-lg"
                bgColor={selected.avatarColor}
              />
              <input
                bind:this={fileInput}
                type="file"
                accept="image/gif,image/jpeg,image/png,image/webp"
                class="hidden"
                onchange={pickAvatar}
              />
              <button
                type="button"
                aria-label="Change {name}'s avatar"
                class="absolute inset-0 flex cursor-pointer items-center justify-center text-white transition-colors hover:bg-black/55 focus-visible:bg-black/55 focus-visible:outline-none"
                disabled={uploading}
                onclick={() => fileInput?.click()}
              >
                {#if uploading}
                  <LoaderCircle class="size-4 animate-spin" />
                {:else}
                  <Camera class="size-4 opacity-0 group-hover:opacity-100" />
                {/if}
              </button>
            </div>
            <div class="min-w-0">
              <h1 class="flex items-center gap-2 text-xl font-semibold">
                <span class="truncate">{name}</span>
                <BotBadge />
              </h1>
              <p class="truncate font-mono text-xs text-muted-foreground">{selected.handle}</p>
            </div>
          </div>

          <Tabs.Root bind:value={tab} class="mt-5 gap-0">
            <Tabs.List
              variant="line"
              class="justify-start gap-1 overflow-x-auto px-0 pt-0 pb-[5px] group-data-horizontal/tabs:h-auto [scrollbar-width:none]"
            >
              {#each tabs as item (item.value)}
                <Tabs.Trigger
                  value={item.value}
                  class="h-9 flex-none px-3 text-sm after:bg-primary"
                >
                  <item.icon class="size-3.5" />
                  {item.label}
                </Tabs.Trigger>
              {/each}
            </Tabs.List>
          </Tabs.Root>
        </div>

        <div class="max-w-2xl px-4 py-6 sm:px-8">
          {#if tab === 'general'}
            <form class="space-y-5" onsubmit={saveProfile}>
              <div class="grid gap-1.5">
                <Label for="bot-display-name">Display name</Label>
                <Input
                  id="bot-display-name"
                  bind:value={displayName}
                  maxlength={64}
                  placeholder={selected.username}
                  oninput={() => (saved = false)}
                />
              </div>
              <div class="grid gap-1.5">
                <Label for="bot-about">About</Label>
                <Textarea
                  id="bot-about"
                  bind:value={about}
                  maxlength={512}
                  rows={4}
                  class="resize-none"
                  placeholder="What does your bot do? People see this on its profile."
                  oninput={() => (saved = false)}
                />
              </div>
              <div class="flex items-center gap-3">
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
                {#if saved}<span class="text-xs text-emerald-500">Saved</span>{/if}
              </div>
            </form>

            <div class="mt-8 flex items-start justify-between gap-6 border-t pt-6">
              <div>
                <Label for="bot-public" class="text-sm">Public bot</Label>
                <p class="mt-1 text-xs leading-5 text-muted-foreground">
                  Anyone who manages a guild can add a public bot. Turn this off and only you can
                  add it.
                </p>
              </div>
              <Switch
                id="bot-public"
                checked={selected.public}
                onCheckedChange={(checked) => setPublic(selected, checked)}
              />
            </div>

            <div class="mt-8 flex items-start justify-between gap-6 border-t pt-6">
              <div>
                <p class="text-sm font-medium">Delete bot</p>
                <p class="mt-1 text-xs leading-5 text-muted-foreground">
                  It leaves every guild and its token stops working. Its messages stay.
                </p>
              </div>
              <Button variant="destructive" onclick={() => (deleteOpen = true)}>
                <Trash2 class="size-3.5" />
                Delete
              </Button>
            </div>
            {#if saveError}
              <p class="mt-4 text-xs text-destructive" role="alert">{saveError}</p>
            {/if}
          {:else if tab === 'token'}
            <h2 class="text-base font-semibold">Token</h2>
            <p class="mt-1 text-sm leading-6 text-muted-foreground">
              Your code logs in as {name} with this token. Anyone who has it controls the bot, so keep
              it out of your code and never share it.
            </p>
            {#if revealed}
              <div class="mt-4 border border-amber-500/40 bg-amber-500/5 p-3">
                <p class="text-xs font-medium text-amber-500">
                  Copy it now. You won't be able to see it again.
                </p>
                <div class="mt-2 flex gap-2">
                  <Input
                    value={revealed}
                    readonly
                    class="font-mono text-xs"
                    aria-label="Bot token"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy token"
                    onclick={() => copy('token', revealed)}
                  >
                    {#if copied === 'token'}<Check class="size-4" />{:else}<Copy
                        class="size-4"
                      />{/if}
                  </Button>
                </div>
              </div>
            {/if}
            <Button variant="outline" class="mt-4" onclick={() => (resetOpen = true)}>
              <KeyRound class="size-3.5" />
              Reset token
            </Button>
            {#if tokenError}<p class="mt-2 text-xs text-destructive">{tokenError}</p>{/if}
            <div class="mt-10">{@render quickstartPanel()}</div>
          {:else if tab === 'commands'}
            <h2 class="text-base font-semibold">Slash commands</h2>
            <p class="mt-1 text-sm leading-6 text-muted-foreground">
              Your bot registers its commands when it starts, and they work in every guild it is in.
            </p>
            {#if selected.commands.length === 0}
              <div class="mt-6 border border-dashed p-6 text-center">
                <SquareSlash class="mx-auto size-8 text-muted-foreground/50" />
                <p class="mt-3 text-sm font-medium">No commands yet</p>
                <p class="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                  Register them from your code with <code class="font-mono"
                    >client.commands.set([...])</code
                  >, then reload this page.
                </p>
              </div>
            {:else}
              <ul class="mt-4">
                {#each selected.commands as command (command.name)}
                  <li class="border-t py-3">
                    <p class="text-sm">
                      <span class="font-semibold">/{command.name}</span>
                      {#each command.options ?? [] as option (option.name)}
                        <span
                          class={cn(
                            'ml-1.5 border px-1 font-mono text-[11px]',
                            option.required ? 'text-foreground' : 'text-muted-foreground'
                          )}
                          title="{option.type}{option.required ? '' : ' (optional)'}"
                          >{option.name}{option.required ? '' : '?'}</span
                        >
                      {/each}
                    </p>
                    <p class="mt-0.5 text-xs text-muted-foreground">{command.description}</p>
                  </li>
                {/each}
              </ul>
            {/if}
          {:else}
            <h2 class="text-base font-semibold">Add {name} to a guild</h2>
            <p class="mt-1 text-sm leading-6 text-muted-foreground">
              Share this link. Whoever opens it picks one of their guilds to add {name} to.
              {#if !selected.public}Your bot is private, so only you can use it.{/if}
            </p>
            <div class="mt-5 grid gap-1.5">
              <Label for="install-role">Role</Label>
              <Select.Root
                type="single"
                value={installRole}
                onValueChange={(value) => (installRole = value === 'ADMIN' ? 'ADMIN' : 'MEMBER')}
              >
                <Select.Trigger id="install-role" class="w-full sm:w-72">
                  {installRole === 'ADMIN' ? 'Admin' : 'Member'}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="MEMBER">Member</Select.Item>
                  <Select.Item value="ADMIN">Admin</Select.Item>
                </Select.Content>
              </Select.Root>
              <p class="text-xs leading-5 text-muted-foreground">
                {installRole === 'ADMIN'
                  ? 'Admins can also manage channels and post in owner-only channels. Only guild owners can add admin bots.'
                  : 'Members can read and send messages, like everyone else in the guild.'}
              </p>
            </div>
            <div class="mt-5 grid gap-1.5">
              <Label for="install-link">Link</Label>
              <div class="flex gap-2">
                <Input id="install-link" value={installUrl} readonly class="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Copy link"
                  onclick={() => copy('link', installUrl)}
                >
                  {#if copied === 'link'}<Check class="size-4" />{:else}<Copy class="size-4" />{/if}
                </Button>
              </div>
            </div>
            <Button class="mt-4" href={installUrl.replace(window.location.origin, '')}>
              <UserPlus class="size-3.5" />
              Add to one of your guilds
            </Button>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</main>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>New bot</Dialog.Title>
      <Dialog.Description>
        Its handle will be @{newUsername.trim() || 'username'}:{anchor.homeServer}.
      </Dialog.Description>
    </Dialog.Header>
    <form class="grid gap-4" onsubmit={create}>
      <div class="grid gap-1.5">
        <Label for="new-bot-username">Username</Label>
        <Input
          id="new-bot-username"
          bind:value={newUsername}
          autocomplete="off"
          spellcheck="false"
          minlength={2}
          maxlength={32}
          pattern="[a-zA-Z0-9._]+"
          placeholder="weatherbot"
          required
        />
        <p class="text-xs text-muted-foreground">Letters, numbers, dots and underscores.</p>
      </div>
      <div class="grid gap-1.5">
        <Label for="new-bot-display-name">Display name</Label>
        <Input
          id="new-bot-display-name"
          bind:value={newDisplayName}
          maxlength={64}
          placeholder="Weather"
        />
      </div>
      {#if createError}<p class="text-xs text-destructive" role="alert">{createError}</p>{/if}
      <Dialog.Footer>
        <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={creating || newUsername.trim().length < 2}>
          {creating ? 'Creating…' : 'Create bot'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={resetOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Reset the token?</Dialog.Title>
      <Dialog.Description>
        The current token stops working right away and anything running with it disconnects.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (resetOpen = false)}>Cancel</Button>
      <Button onclick={resetToken} disabled={resetting}>
        {resetting ? 'Resetting…' : 'Reset token'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Delete {selected?.displayName || selected?.username}?</Dialog.Title>
      <Dialog.Description>
        This can't be undone. Type <span class="font-mono">{selected?.username}</span> to confirm.
      </Dialog.Description>
    </Dialog.Header>
    <Input bind:value={deleteConfirm} aria-label="Bot username" autocomplete="off" />
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (deleteOpen = false)}>Cancel</Button>
      <Button
        variant="destructive"
        onclick={deleteBot}
        disabled={deleting || deleteConfirm !== selected?.username}
      >
        {deleting ? 'Deleting…' : 'Delete bot'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<AvatarCropDialog
  bind:open={cropOpen}
  file={cropFile}
  onCrop={uploadAvatar}
  title="Crop avatar"
  description="Adjust the image to fit your bot's avatar."
  actionLabel="Use avatar"
/>
