<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Users, Cog, Tags, Camera, Bot, Ban } from '@lucide/svelte';
  import * as Select from '$lib/components/ui/select/index.js';
  import BotBadge from './bot-badge.svelte';
  import { addBotToGuild, parseBotHandle, removeBotFromGuild } from '$lib/bots.svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import type { Server } from '$lib/types/chat';
  import Avatar from './avatar.svelte';
  import AvatarCropDialog from './avatar-crop-dialog.svelte';
  import { canModerate, listBans, moderation, unban, type GuildBan } from '$lib/moderation.svelte';

  let {
    open = $bindable(false),
    server,
  }: {
    open: boolean;
    server: Server;
  } = $props();

  function initialsFor(name: string) {
    return name
      .split(/[^a-zA-Z0-9]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
      .slice(0, 2);
  }

  let botHandle = $state('');
  let botRole = $state<'MEMBER' | 'ADMIN'>('MEMBER');
  let botBusy = $state(false);
  let botMessage = $state<{ ok: boolean; text: string } | null>(null);
  const bots = $derived(chat.members.filter((member) => member.isBot));

  async function addBot(event: SubmitEvent) {
    event.preventDefault();
    const ref = parseBotHandle(botHandle);
    if (!ref)
      return void (botMessage = { ok: false, text: 'Use a full handle, like @name:server.' });
    botBusy = true;
    const error = await addBotToGuild(server.id, ref, botRole);
    botBusy = false;
    botMessage = error
      ? { ok: false, text: error }
      : { ok: true, text: `Added @${ref.username}:${ref.homeserver}.` };
    if (!error) botHandle = '';
  }

  async function removeBot(userId: string) {
    botBusy = true;
    const error = await removeBotFromGuild(server.id, userId);
    botBusy = false;
    botMessage = error ? { ok: false, text: error } : null;
  }

  let tab = $state('server');
  let bans = $state<GuildBan[]>([]);
  let bansError = $state<string | null>(null);
  let bansBusy = $state(false);

  async function loadBans() {
    bansBusy = true;
    const result = await listBans(server.id);
    bansBusy = false;
    if (typeof result === 'string') bansError = result;
    else [bans, bansError] = [result, null];
  }

  async function liftBan(userId: string) {
    bansBusy = true;
    bansError = await unban(server.id, userId);
    bansBusy = false;
    if (!bansError) bans = bans.filter((ban) => ban.user.userId !== userId);
  }

  // a ban made from the members tab shows up here the next time the tab opens
  $effect(() => {
    if (open && tab === 'bans' && !moderation.pending) void loadBans();
  });

  let fileInput: HTMLInputElement;
  let cropFile = $state<File | null>(null);
  let cropOpen = $state(false);
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);

  function selectPicture(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      uploadError = 'Choose a GIF, JPEG, PNG, or WebP image.';
      return;
    }

    uploadError = null;
    if (file.type === 'image/gif') {
      void uploadPicture(file);
      return;
    }

    cropFile = file;
    cropOpen = true;
  }

  async function uploadPicture(blob: Blob) {
    uploading = true;
    uploadError = null;
    const type = blob.type === 'image/gif' ? 'image/gif' : 'image/png';
    const avatar = new File([blob], `guild-avatar.${type === 'image/gif' ? 'gif' : 'png'}`, {
      type,
    });

    try {
      const result = await anchor.client.guilds({ id: server.id }).avatar.post({ avatar });
      if (result.error || !result.data || 'error' in result.data) {
        uploadError = 'Could not upload the guild picture.';
        return;
      }

      chat.updateGuildAvatar(server.id, result.data.avatarUrl);
    } catch {
      uploadError = 'Could not upload the guild picture.';
    } finally {
      uploading = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Guild Settings</Dialog.Title>
      <Dialog.Description>Manage how your guild appears to members.</Dialog.Description>
    </Dialog.Header>

    <Tabs.Root
      bind:value={tab}
      orientation="vertical"
      class="flex flex-col gap-4 sm:h-[420px] sm:flex-row sm:gap-0"
    >
      <div
        class="flex min-w-0 shrink-0 flex-col gap-2 sm:w-44 sm:border-r sm:border-border sm:pr-2"
      >
        <Tabs.List
          class="flex h-auto w-full items-stretch justify-start gap-0.5 overflow-x-auto bg-transparent p-0 sm:flex-col sm:overflow-visible"
        >
          <Tabs.Trigger
            value="server"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Cog class="size-3.5" />
            Server Profile
          </Tabs.Trigger>

          <Tabs.Trigger
            value="members"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Users class="size-3.5" />
            Members
          </Tabs.Trigger>

          <Tabs.Trigger
            value="bans"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Ban class="size-3.5" />
            Bans
          </Tabs.Trigger>

          <Tabs.Trigger
            value="bots"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Bot class="size-3.5" />
            Bots
          </Tabs.Trigger>

          <Tabs.Trigger
            value="roles"
            class="min-h-10 shrink-0 justify-start gap-2 rounded-none px-2 py-1.5 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground sm:w-full"
          >
            <Tags class="size-3.5" />
            Roles
          </Tabs.Trigger>
        </Tabs.List>
      </div>

      <div class="min-w-0 flex-1 sm:pl-4">
        <Tabs.Content value="server" class="sm:h-full sm:overflow-y-auto sm:pr-1">
          <div class="space-y-5 pb-1">
            <div class="flex items-center gap-4">
              <div class="group relative size-16 shrink-0 overflow-hidden rounded-full">
                <Avatar src={server.avatarUrl} name={server.name} class="size-16 text-lg" />

                <input
                  bind:this={fileInput}
                  type="file"
                  accept="image/gif,image/jpeg,image/png,image/webp"
                  class="hidden"
                  onchange={selectPicture}
                />

                <button
                  type="button"
                  aria-label="Change guild picture"
                  class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/55 focus-visible:bg-black/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80 disabled:cursor-wait"
                  disabled={uploading}
                  onclick={() => fileInput.click()}
                >
                  <span
                    class="flex flex-col items-center gap-0.5 text-[10px] font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    class:opacity-100={uploading}
                  >
                    <Camera class="size-4" />
                    {uploading ? 'Uploading...' : ''}
                  </span>
                </button>
              </div>

              <div class="space-y-1.5">
                <p class="text-xs font-medium">Guild Picture</p>
                <p class="text-[11px] text-muted-foreground">
                  GIF, JPEG, PNG, or WebP formats are supported!
                </p>
              </div>
            </div>

            <div class="grid gap-1.5">
              <Label for="guild-name">Guild Name</Label>
              <Input id="guild-name" value={server.name} disabled />
            </div>

            <div class="grid gap-1.5">
              <Label for="guild-description">Description</Label>
              <textarea
                id="guild-description"
                class="min-h-20 w-full resize-none border border-input bg-transparent px-3 py-2 text-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled
                placeholder="Add a description for your guild"
                value={server.description ?? ''}></textarea>
              <p class="text-[11px] text-muted-foreground">More guild settings are coming soon!</p>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="members" class="sm:h-full sm:overflow-y-auto sm:pr-1">
          <div class="space-y-3 pb-1">
            <p class="text-xs font-medium">
              Members <span class="text-muted-foreground">({chat.members.length})</span>
            </p>
            <div class="space-y-1.5">
              {#each chat.members as member (member.userId)}
                <div class="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
                  <Avatar
                    src={member.avatarUrl}
                    name={member.displayName || member.username}
                    fallback={initialsFor(member.username)}
                    class="size-8 shrink-0 text-xs"
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">
                      {member.displayName || member.username}
                    </p>
                    <p class="truncate text-xs text-muted-foreground">
                      @{member.username}:{member.server}
                    </p>
                  </div>
                  {#if canModerate(server, member)}
                    <div class="flex shrink-0 gap-1.5">
                      <Button
                        variant="destructive"
                        size="xs"
                        onclick={() => moderation.ask({ kind: 'kick', server, member })}
                        >Kick</Button
                      >
                      <Button
                        variant="destructive"
                        size="xs"
                        onclick={() => moderation.ask({ kind: 'ban', server, member })}>Ban</Button
                      >
                    </div>
                  {/if}
                </div>
              {/each}
              {#if chat.members.length === 0}
                <p class="text-[11px] text-muted-foreground">No members found.</p>
              {/if}
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="bans" class="sm:h-full sm:overflow-y-auto sm:pr-1">
          <div class="space-y-3 pb-1">
            <p class="text-xs font-medium">
              Banned <span class="text-muted-foreground">({bans.length})</span>
            </p>
            {#if bansError}
              <p class="text-xs text-destructive" role="alert">{bansError}</p>
            {/if}
            <div class="space-y-1.5">
              {#each bans as ban (ban.user.userId)}
                <div class="flex items-center gap-3 border bg-card px-3 py-2">
                  <Avatar
                    src={ban.user.avatarUrl}
                    name={ban.user.displayName || ban.user.username}
                    class="size-8 shrink-0 text-xs"
                    bgColor={ban.user.avatarColor}
                  />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">
                      {ban.user.displayName || ban.user.username}
                      <span class="text-xs font-normal text-muted-foreground"
                        >@{ban.user.username}:{ban.user.homeserver}</span
                      >
                    </p>
                    <p class="truncate text-xs text-muted-foreground">
                      {ban.reason || 'No reason given'}
                      {#if ban.bannedBy}· by {ban.bannedBy.displayName ||
                          ban.bannedBy.username}{/if}
                      · {new Date(ban.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={bansBusy}
                    onclick={() => liftBan(ban.user.userId)}>Unban</Button
                  >
                </div>
              {:else}
                {#if !bansBusy && !bansError}
                  <p class="text-[11px] text-muted-foreground">Nobody is banned.</p>
                {/if}
              {/each}
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="bots" class="sm:h-full sm:overflow-y-auto sm:pr-1">
          <div class="space-y-5 pb-1">
            <form class="grid gap-2" onsubmit={addBot}>
              <Label for="bot-handle">Add a bot</Label>
              <div class="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="bot-handle"
                  bind:value={botHandle}
                  placeholder="@weatherbot:novarum.me"
                  autocomplete="off"
                  spellcheck="false"
                  oninput={() => (botMessage = null)}
                />
                <Select.Root
                  type="single"
                  value={botRole}
                  onValueChange={(value) => (botRole = value === 'ADMIN' ? 'ADMIN' : 'MEMBER')}
                >
                  <Select.Trigger class="sm:w-32" aria-label="Role"
                    >{botRole === 'ADMIN' ? 'Admin' : 'Member'}</Select.Trigger
                  >
                  <Select.Content>
                    <Select.Item value="MEMBER">Member</Select.Item>
                    <Select.Item value="ADMIN">Admin</Select.Item>
                  </Select.Content>
                </Select.Root>
                <Button type="submit" disabled={botBusy || !botHandle.trim()}>Add</Button>
              </div>
              {#if botMessage}
                <p
                  class="text-xs {botMessage.ok ? 'text-emerald-500' : 'text-destructive'}"
                  role="status"
                >
                  {botMessage.text}
                </p>
              {:else}
                <p class="text-[11px] text-muted-foreground">
                  Bots can read and send messages in every channel. Only the guild owner can add
                  admin bots.
                </p>
              {/if}
            </form>

            <div class="space-y-1.5">
              <p class="text-xs font-medium">
                In this guild <span class="text-muted-foreground">({bots.length})</span>
              </p>
              {#each bots as member (member.userId)}
                <div class="flex items-center gap-3 border bg-card px-3 py-2">
                  <Avatar
                    src={member.avatarUrl}
                    name={member.displayName || member.username}
                    class="size-8 shrink-0 text-xs"
                    bgColor={member.avatarColor}
                  />
                  <div class="min-w-0 flex-1">
                    <p class="flex items-center gap-1.5 truncate text-sm font-medium">
                      {member.displayName || member.username}
                      <BotBadge />
                    </p>
                    <p class="truncate text-xs text-muted-foreground">
                      @{member.username}:{member.server}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="xs"
                    disabled={botBusy}
                    onclick={() => removeBot(member.userId)}>Remove</Button
                  >
                </div>
              {:else}
                <p class="text-[11px] text-muted-foreground">
                  No bots yet. Add one with its handle, or open a bot's invite link.
                </p>
              {/each}
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="roles" class="sm:h-full sm:overflow-y-auto sm:pr-1">
          <div class="space-y-3 pb-1">
            <p class="text-[11px] text-muted-foreground">Role management is coming soon™</p>
          </div>
        </Tabs.Content>
      </div>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>

<AvatarCropDialog
  bind:open={cropOpen}
  file={cropFile}
  onCrop={uploadPicture}
  title="Crop Guild Picture"
  description="Adjust the image to fit your guild icon."
  actionLabel="Use Picture"
/>
