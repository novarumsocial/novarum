<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    Bot,
    Camera,
    Check,
    ChevronRight,
    ChevronsUpDown,
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
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
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
  import SettingsGroup from './settings-group.svelte';
  import SettingsRow from './settings-row.svelte';

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
  const previewName = $derived(displayName.trim() || selected?.username || '');

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
  const roles = [
    {
      value: 'MEMBER',
      label: 'Member',
      description: 'Reads and sends messages, like everyone else in the guild.',
    },
    {
      value: 'ADMIN',
      label: 'Admin',
      description:
        'Also manages channels and posts in owner-only channels. Only guild owners can add admin bots.',
    },
  ] as const;
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

{#snippet copyButton(what: string, text: string)}
  <Button
    variant="ghost"
    size="icon-sm"
    class="shrink-0 text-muted-foreground"
    aria-label="Copy {what}"
    onclick={() => copy(what, text)}
  >
    {#if copied === what}<Check class="size-3.5 text-emerald-500" />{:else}<Copy
        class="size-3.5"
      />{/if}
  </Button>
{/snippet}

{#snippet code(text: string, title: string)}
  <div class="border bg-sidebar">
    <div class="flex h-9 items-center justify-between border-b pr-1 pl-3">
      <span class="text-xs text-muted-foreground">{title}</span>
      {@render copyButton(title, text)}
    </div>
    <pre class="overflow-x-auto p-3 font-mono text-xs leading-5"><code>{text}</code></pre>
  </div>
{/snippet}

{#snippet quickstartPanel()}
  <section class="min-w-0">
    <h2 class="text-base font-semibold">Run your bot</h2>
    <p class="mt-1 text-sm leading-6 text-muted-foreground">
      Install the SDK, {revealed ? 'put the token in a .env file, ' : ''}save the code as bot.ts and
      start it with
      <code class="font-mono text-xs">bun bot.ts</code>.
    </p>
    <div class="mt-4 space-y-2">
      {@render code('bun add @novarum/sdk', 'Terminal')}
      {#if revealed}{@render code(`BOT_TOKEN=${revealed}`, '.env')}{/if}
      {@render code(quickstart, 'bot.ts')}
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
  <header class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
    <Button
      variant="ghost"
      size="icon-sm"
      class="md:hidden"
      onclick={onOpenNavigation}
      aria-label="Open navigation"
    >
      <Menu class="size-5" />
    </Button>
    <nav class="flex min-w-0 items-center gap-1.5 text-sm font-semibold" aria-label="Breadcrumb">
      <Bot class="mr-0.5 size-5 shrink-0 text-muted-foreground" />
      {#if selected}
        <a href="/guilds/developers" class="text-muted-foreground hover:text-foreground"
          >Developers</a
        >
        <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="sm"
                class="-ml-1 min-w-0 gap-1 px-2 text-sm font-semibold"
                aria-label="Switch bot"
              >
                <span class="truncate">{previewName}</span>
                <ChevronsUpDown class="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="max-h-80 w-60 overflow-y-auto" align="start">
            {#each developers.bots as bot (bot.userId)}
              {@const name = bot.displayName || bot.username}
              <DropdownMenu.Item onclick={() => open(bot.userId)}>
                <Avatar
                  src={bot.avatarUrl}
                  {name}
                  class="size-6 text-[10px]"
                  bgColor={bot.avatarColor}
                />
                <span class="min-w-0 flex-1 truncate">{name}</span>
                {#if bot.userId === selectedId}<Check class="size-3.5" />{/if}
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {:else}
        Developers
      {/if}
    </nav>
    <Button size="sm" class="ml-auto shrink-0" onclick={() => (createOpen = true)}>
      <Plus class="size-3.5" />
      New bot
    </Button>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if !selected}
      <div class="grid gap-x-12 gap-y-10 px-4 py-6 sm:px-8 sm:py-8 xl:grid-cols-2">
        <section class="min-w-0">
          {#if developers.loaded && developers.bots.length === 0}
            <h1 class="text-xl font-semibold">Make a bot for Novarum</h1>
            <p class="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">
              A bot is an account your code controls. It can read and send messages in the guilds it
              is added to, register slash commands and answer with embeds and buttons.
            </p>
            <Button class="mt-4" onclick={() => (createOpen = true)}>
              <Plus class="size-3.5" />
              Make your first bot
            </Button>
          {:else if developers.loaded}
            <h1 class="text-base font-semibold">Your bots</h1>
            <p class="mt-1 text-sm leading-6 text-muted-foreground">
              Pick one to change its profile, token or commands.
            </p>
            <ul class="mt-4 border-b">
              {#each developers.bots as bot (bot.userId)}
                {@const name = bot.displayName || bot.username}
                <li>
                  <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-3 border-t px-3 py-3 text-left hover:bg-card focus-visible:bg-card focus-visible:outline-none"
                    onclick={() => {
                      tab = 'general';
                      void open(bot.userId);
                    }}
                  >
                    <Avatar
                      src={bot.avatarUrl}
                      {name}
                      class="size-10 text-sm"
                      bgColor={bot.avatarColor}
                    />
                    <span class="min-w-0 flex-1 leading-tight">
                      <span class="flex items-center gap-2">
                        <span class="truncate text-sm font-semibold">{name}</span>
                        {#if !bot.public}
                          <span
                            class="shrink-0 border px-1 text-[10px] leading-4 text-muted-foreground"
                            >Private</span
                          >
                        {/if}
                      </span>
                      <span class="mt-0.5 block truncate text-xs text-muted-foreground"
                        >{bot.handle}</span
                      >
                    </span>
                    <span
                      class="hidden w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block"
                    >
                      {bot.commands.length}
                      {bot.commands.length === 1 ? 'command' : 'commands'}
                    </span>
                    <span
                      class="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
                    >
                      {bot.guildCount}
                      {bot.guildCount === 1 ? 'guild' : 'guilds'}
                    </span>
                    <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              {/each}
            </ul>
          {:else if developers.loading}
            <p class="text-sm text-muted-foreground">Loading your bots…</p>
          {/if}
          {#if developers.error}
            <p class="mt-4 border-l-2 border-destructive pl-3 text-xs leading-5 text-destructive">
              {developers.error}
            </p>
          {/if}
        </section>
        {@render quickstartPanel()}
      </div>
    {:else}
      <div class="xl:grid xl:min-h-full xl:grid-cols-[minmax(0,1fr)_20rem]">
        <!-- how the bot looks to everyone else; follows the form as you type -->
        <aside class="xl:col-start-2 xl:row-start-1 xl:border-l">
          <div class="h-16 bg-primary xl:h-20" style:background-color={selected.avatarColor}></div>
          <div class="px-4 sm:px-8 xl:px-5 xl:pb-6">
            <div class="relative -mt-8 w-fit">
              <Avatar
                src={selected.avatarUrl}
                name={previewName}
                class="size-16 border-4 border-background text-xl"
                bgColor={selected.avatarColor}
              />
              <input
                bind:this={fileInput}
                type="file"
                accept="image/gif,image/jpeg,image/png,image/webp"
                class="hidden"
                onchange={pickAvatar}
              />
              <Button
                variant="outline"
                size="icon-sm"
                class="absolute -right-2 -bottom-1 size-7 bg-card!"
                aria-label="Change avatar"
                disabled={uploading}
                onclick={() => fileInput?.click()}
              >
                {#if uploading}
                  <LoaderCircle class="size-3.5 animate-spin" />
                {:else}
                  <Camera class="size-3.5" />
                {/if}
              </Button>
            </div>
            <h1 class="mt-3 flex items-center gap-2 text-lg font-semibold">
              <span class="truncate">{previewName}</span>
              <BotBadge />
            </h1>
            <div class="flex items-center gap-1">
              <p class="truncate text-xs text-muted-foreground">{selected.handle}</p>
              {@render copyButton('handle', selected.handle)}
            </div>
            <div class="hidden xl:block">
              <p
                class={cn(
                  'mt-3 text-sm leading-6 break-words whitespace-pre-wrap',
                  !about.trim() && 'text-muted-foreground'
                )}
              >
                {about.trim() || 'No description yet.'}
              </p>
              <dl class="mt-5 grid gap-2.5 border-t pt-5 text-sm">
                {#each [['Guilds', selected.guildCount], ['Commands', selected.commands.length], ['Visibility', selected.public ? 'Public' : 'Private'], ['Created', new Date(selected.createdAt).toLocaleDateString( undefined, { dateStyle: 'medium' } )]] as [label, value] (label)}
                  <div class="flex justify-between gap-4">
                    <dt class="text-muted-foreground">{label}</dt>
                    <dd class="tabular-nums">{value}</dd>
                  </div>
                {/each}
              </dl>
            </div>
          </div>
        </aside>

        <div class="min-w-0 xl:col-start-1 xl:row-start-1">
          <Tabs.Root bind:value={tab} class="gap-0 border-b px-4 pt-3 sm:px-8">
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

              <div class="mt-8">
                <SettingsGroup>
                  <SettingsRow
                    id="bot-public"
                    title="Public bot"
                    description="Anyone who manages a guild can add a public bot. Turn this off and only you can add it."
                  >
                    <Switch
                      id="bot-public"
                      checked={selected.public}
                      onCheckedChange={(checked) => setPublic(selected, checked)}
                    />
                  </SettingsRow>
                  <SettingsRow
                    title="Delete bot"
                    description="It leaves every guild and its token stops working. Its messages stay."
                  >
                    <Button variant="destructive" onclick={() => (deleteOpen = true)}>
                      <Trash2 class="size-3.5" />
                      Delete
                    </Button>
                  </SettingsRow>
                </SettingsGroup>
              </div>
              {#if saveError}
                <p class="mt-4 text-xs text-destructive" role="alert">{saveError}</p>
              {/if}
            {:else if tab === 'token'}
              <h2 class="text-base font-semibold">Token</h2>
              <p class="mt-1 text-sm leading-6 text-muted-foreground">
                Your code logs in as {previewName} with this token. Anyone who has it controls the bot,
                so keep it out of your code and never share it.
              </p>
              <div class="mt-4 flex flex-col gap-2 sm:flex-row">
                <div class="flex min-w-0 flex-1 gap-2">
                  <Input
                    value={revealed ?? '•'.repeat(40)}
                    readonly
                    disabled={!revealed}
                    class="font-mono text-xs"
                    aria-label="Bot token"
                  />
                  {#if revealed}
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
                  {/if}
                </div>
                <Button variant="outline" onclick={() => (resetOpen = true)}>
                  <KeyRound class="size-3.5" />
                  Reset token
                </Button>
              </div>
              {#if revealed}
                <p class="mt-2 text-xs font-medium text-amber-500">
                  Copy it now. You won't be able to see it again.
                </p>
              {:else}
                <p class="mt-2 text-xs text-muted-foreground">
                  A token is only shown once. If you lost it, reset it to get a new one.
                </p>
              {/if}
              {#if tokenError}<p class="mt-2 text-xs text-destructive">{tokenError}</p>{/if}
              <div class="mt-10">{@render quickstartPanel()}</div>
            {:else if tab === 'commands'}
              <h2 class="text-base font-semibold">Slash commands</h2>
              <p class="mt-1 text-sm leading-6 text-muted-foreground">
                Your bot registers its commands when it starts, and they work in every guild it is
                in.
              </p>
              {#if selected.commands.length === 0}
                <div class="mt-5 bg-card px-4 py-8 text-center">
                  <SquareSlash class="mx-auto size-8 text-muted-foreground/50" />
                  <p class="mt-3 text-sm font-medium">No commands yet</p>
                  <p class="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                    Register them from your code with <code class="font-mono"
                      >client.commands.set([...])</code
                    >, then reload this page.
                  </p>
                </div>
              {:else}
                <ul class="mt-5 divide-y divide-border/60 bg-card">
                  {#each selected.commands as command (command.name)}
                    <li class="px-4 py-3.5">
                      <p class="flex flex-wrap items-center gap-1.5 text-sm">
                        <span class="mr-1 font-semibold">/{command.name}</span>
                        {#each command.options ?? [] as option (option.name)}
                          <span
                            class={cn(
                              'border px-1.5 text-xs leading-5',
                              option.required ? 'text-foreground' : 'text-muted-foreground'
                            )}
                            title="{option.type}{option.required ? '' : ' (optional)'}"
                            >{option.name}{option.required ? '' : '?'}</span
                          >
                        {/each}
                      </p>
                      <p class="mt-1 text-xs text-muted-foreground">{command.description}</p>
                    </li>
                  {/each}
                </ul>
              {/if}
            {:else}
              <h2 class="text-base font-semibold">Add {previewName} to a guild</h2>
              <p class="mt-1 text-sm leading-6 text-muted-foreground">
                Share this link. Whoever opens it picks one of their guilds to add {previewName} to.
                {#if !selected.public}Your bot is private, so only you can use it.{/if}
              </p>
              <RadioGroup.Root
                value={installRole}
                onValueChange={(value) => (installRole = value === 'ADMIN' ? 'ADMIN' : 'MEMBER')}
                class="mt-5 gap-0 divide-y divide-border/60 bg-card"
                aria-label="Role"
              >
                {#each roles as role (role.value)}
                  <label
                    for="install-{role.value}"
                    class="flex cursor-pointer items-start gap-3 px-4 py-3.5"
                  >
                    <RadioGroup.Item value={role.value} id="install-{role.value}" class="mt-0.5" />
                    <span>
                      <span class="block text-sm font-medium">{role.label}</span>
                      <span class="mt-0.5 block text-xs leading-relaxed text-muted-foreground"
                        >{role.description}</span
                      >
                    </span>
                  </label>
                {/each}
              </RadioGroup.Root>
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
                    {#if copied === 'link'}<Check class="size-4" />{:else}<Copy
                        class="size-4"
                      />{/if}
                  </Button>
                </div>
              </div>
              <Button class="mt-4" href={installUrl.replace(window.location.origin, '')}>
                <UserPlus class="size-3.5" />
                Add to one of your guilds
              </Button>
            {/if}
          </div>
        </div>
      </div>
    {/if}
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
