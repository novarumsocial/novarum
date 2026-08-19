<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Author } from '$lib/types/chat';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { settings } from '$lib/settings.svelte';
  import { friends } from '$lib/friends.svelte';
  import { useSession } from '$lib/session.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    UserRoundArrowLeft,
    UserRoundCheck,
    UserRoundCog,
    UserRoundMinus,
    UserRoundPlus,
  } from '@lucide/svelte';
  import Avatar from './avatar.svelte';
  import AnimatedImage from './animated-image.svelte';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    user,
    children,
    class: className = '',
  }: {
    user: Author;
    children: Snippet;
    class?: string;
  } = $props();

  const session = useSession();
  const name = $derived(user.displayName || user.username);
  const friendStatus = $derived(friends.statusFor(user.username, user.server));
  const friendshipUserId = $derived(friends.userIdFor(user.username, user.server));
  const isSelf = $derived(
    Boolean(session.user) &&
      user.username === session.user?.username &&
      user.server === session.user?.homeserver
  );
  const busy = $derived(
    friends.busyUserIds.includes(user.userId) ||
      (friendshipUserId ? friends.busyUserIds.includes(friendshipUserId) : false)
  );
  const canAddFriend = $derived(
    Boolean(user.userId) && user.userId !== session.user?.id && !user.isBot
  );
  const friendAction = $derived.by(() => {
    switch (friendStatus) {
      case 'INCOMING':
        return {
          label: 'Accept friend request',
          run: () => friendshipUserId && friends.accept(friendshipUserId),
        };
      case 'OUTGOING':
        return {
          label: 'Cancel friend request',
          run: () => friendshipUserId && friends.remove(friendshipUserId),
        };
      case 'FRIEND':
        return {
          label: 'Remove friend',
          run: () => friendshipUserId && friends.remove(friendshipUserId),
        };
      default:
        return {
          label: 'Add friend',
          run: () => friends.request(user.userId, user.username, user.server),
        };
    }
  });
</script>

<Popover.Root>
  <Popover.Trigger class="cursor-pointer text-left {className}">
    {@render children()}
  </Popover.Trigger>

  <Popover.Content align="start" side="right" class="w-72 overflow-hidden mx-2 p-0">
    <div class="relative aspect-[3/1] overflow-hidden" style:background-color={user.avatarColor}>
      {#if user.bannerUrl}
        <AnimatedImage
          src={user.bannerUrl}
          alt=""
          class="size-full select-none"
          focused={false}
          fit="contain"
        />
      {:else}
        <div
          class="absolute inset-0 opacity-20"
          style="background-image: repeating-linear-gradient(135deg, transparent 0 10px, currentColor 10px 11px)"
        ></div>
      {/if}
    </div>

    <div class="relative px-4 pb-4">
      {#if canAddFriend && !user.isBot}
        <Button
          variant="outline"
          size="icon"
          class="group absolute top-1 right-3"
          disabled={busy}
          aria-label={friendAction.label}
          onclick={friendAction.run}
        >
          {#if friendStatus === 'INCOMING'}
            <UserRoundArrowLeft />
          {:else if friendStatus === 'OUTGOING'}
            <UserRoundCog />
          {:else if friendStatus === 'FRIEND'}
            <div class="group-hover:hidden">
              <UserRoundCheck />
            </div>
            <div class="hidden group-hover:block text-destructive">
              <UserRoundMinus />
            </div>
          {:else}
            <UserRoundPlus />
          {/if}
        </Button>
      {/if}

      <div class="relative -mt-8 w-fit">
        <Avatar
          src={user.avatarUrl}
          {name}
          class="size-16 border-4 border-popover text-xl"
          bgColor={user.avatarColor}
        />
        {#if user.status}
          <span
            class="absolute bottom-0 right-0 size-3.5 border-[3px] border-popover {user.status ===
            'ONLINE'
              ? 'bg-emerald-500'
              : 'bg-neutral-900 ring-3 ring-inset ring-neutral-500'}"
            class:rounded-full={settings.value.circleIcons}
            class:size-5={settings.value.circleIcons}
            class:mr-0.25={settings.value.circleIcons}
            class:mb-0.25={settings.value.circleIcons}
            class:border-[4px]={settings.value.circleIcons}
            aria-label={user.status === 'ONLINE' ? 'Online' : 'Offline'}
          ></span>
        {/if}
      </div>

      <div class="mt-2 flex items-center gap-2">
        <Popover.Title class="truncate text-base font-semibold">{name}</Popover.Title>
        {#if user.isBot}
          <span
            class="bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-primary"
          >
            BOT
          </span>
        {/if}
      </div>
      <Popover.Description class="flex items-center gap-1 truncate font-mono text-[11px]">
        <span class="truncate">@{user.username}:{user.server}</span>
        <!-- TODO: pronouns
        {#if user.pronouns
        <span class="flex shrink-0 items-center gap-1 text-muted-foreground">
          <span aria-hidden="true">•</span>
          <span class="rounded-full bg-muted px-1.5 py-0.5 mb-1 text-[10px] font-medium">
            pro/nouns
          </span>
        </span>
        {/if}
        -->
      </Popover.Description>
      {#if user.about}
        <p class="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80">
          {user.about}
        </p>
      {/if}
      {#if user.username && !isSelf}
        <Input
          id="direct-message-person"
          placeholder="Message @{user.username}:{user.server}"
          class="mt-2.5"
          autocomplete="off"
          spellcheck="false"
        />
      {/if}
    </div>
  </Popover.Content>
</Popover.Root>
