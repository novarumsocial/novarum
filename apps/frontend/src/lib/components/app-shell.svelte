<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { useSession } from '$lib/session.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { realtime } from '$lib/realtime.svelte';
  import { friends } from '$lib/friends.svelte';
  import { dms } from '$lib/dms.svelte';
  import { device } from '$lib/device.svelte';
  import { Voice } from '$lib/voice.svelte';
  import ServerSidebar from './guild-sidebar.svelte';
  import ChannelSidebar from './channel-sidebar.svelte';
  import ChatArea from './chat-area.svelte';
  import VoiceArea from './voice-area.svelte';
  import InitialLoader from './initial-loader.svelte';
  import MemberSidebar from './member-sidebar.svelte';
  import type { Channel } from '$lib/types/chat';
  import UserArea from './user-area.svelte';
  import FriendsHome from './friends-home.svelte';
  import DmSidebar from './dm-sidebar.svelte';
  import { X } from '@lucide/svelte';
  import { ConnectionState } from 'livekit-client';

  const session = useSession();

  const currentUser = $derived(session.user);
  let booting = $state(true);
  let bootFinished = $state(false);
  let mobileNavigationOpen = $state(false);
  let mobileMembersOpen = $state(false);
  let swipeStart: { x: number; y: number } | null = null;

  const currentServer = $derived(chat.currentServer);
  const currentCategories = $derived(chat.currentCategories);
  const currentChannel = $derived(chat.currentChannel);
  const currentMessages = $derived(chat.currentMessages);
  const currentMessagesLoading = $derived(chat.currentMessagesLoading);
  const guildMentions = $derived(
    Object.fromEntries(
      Object.entries(chat.channelsByServer).map(([guildId, categories]) => [
        guildId,
        categories
          .flatMap((category) => category.channels)
          .reduce((sum, channel) => sum + channel.mention, 0),
      ])
    )
  );
  const hasUnreadDms = $derived(dms.list.some((dm) => dm.unread));

  const callMembers = $derived(
    chat.route.kind === 'dms' && currentUser
      ? [
          { ...currentUser, userId: currentUser.id, server: currentUser.homeserver },
          ...(dms
            .get(chat.activeChannel ?? '')
            ?.participants.map(({ homeserver, ...user }) => ({ ...user, server: homeserver })) ??
            []),
        ]
      : chat.members
  );

  const voice = new Voice();
  let callExpanded = $state(false);

  function startCall(id: string) {
    // phones have no room for the call and the chat side by side, so start it expanded.
    if (!device.isComputer) callExpanded = true;
    void voice.join(id).catch(() => null);
  }

  const voiceChannelName = $derived(
    Object.values(chat.channelsByServer)
      .flatMap((categories) => categories)
      .flatMap((category) => category.channels)
      .find((channel) => channel.id === voice.channelId)?.name ??
      (voice.channelId ? dms.get(voice.channelId)?.participants[0]?.username : null) ??
      null
  );

  $effect(() => {
    if (!booting) chat.syncActiveChannel();
  });

  async function boot() {
    const user = await session.refresh();

    if (!user) {
      await goto('/login');
      return;
    }

    await Promise.all([chat.loadInitialData(), friends.load()]);
    bootFinished = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    booting = false;
  }

  function leaveVoice() {
    void voice.leave();
  }

  function selectServer(id?: string) {
    chat.selectServer(id);
  }

  function selectChannel(id: string) {
    const channel = currentCategories
      .flatMap((category) => category.channels)
      .find((channel) => channel.id === id)!;

    mobileNavigationOpen = false;
    // if you squint you'll understand...
    if (
      channel.type !== 'VOICE' ||
      (voice.connectionState !== ConnectionState.Disconnected && voice.channelId === id)
    ) {
      chat.selectChannel(id);
    }
    if (channel.type === 'VOICE') void voice.join(id).catch(() => null);
  }

  function startSwipe(event: TouchEvent) {
    const touch = event.touches[0];
    if (
      !touch ||
      !(event.target instanceof Element) ||
      event.target.closest(
        'input, textarea, select, [contenteditable="true"], .touch-none, .overflow-x-auto, [data-slot^="dialog-"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-slot="carousel-content"]'
      )
    ) {
      return;
    }

    swipeStart = { x: touch.clientX, y: touch.clientY };
  }

  function finishSwipe(event: TouchEvent) {
    const touch = event.changedTouches[0];
    if (!swipeStart || !touch) return;

    const start = swipeStart;
    swipeStart = null;
    const x = touch.clientX - start.x;
    const y = touch.clientY - start.y;
    if (Math.abs(x) < 56 || Math.abs(x) < Math.abs(y) * 1.25) return;

    if (mobileNavigationOpen && x < 0) mobileNavigationOpen = false;
    else if (mobileMembersOpen && x > 0) mobileMembersOpen = false;
    else if (x > 0 && window.innerWidth < 768) openNavigation();
    else if (x < 0 && window.innerWidth < 1024 && chat.route.kind === 'guild') {
      openMembers();
    }
  }

  function openNavigation() {
    mobileMembersOpen = false;
    mobileNavigationOpen = true;
  }

  function openMembers() {
    mobileNavigationOpen = false;
    mobileMembersOpen = true;
  }

  onMount(() => {
    const disconnect = realtime.connect();
    void boot();

    return () => {
      disconnect();
      void voice.leave();
    };
  });
</script>

<svelte:window
  ontouchstart={startSwipe}
  ontouchend={finishSwipe}
  ontouchcancel={() => (swipeStart = null)}
/>

{#if booting}
  <InitialLoader finished={bootFinished} />
{:else if currentUser}
  <div class="flex h-svh overflow-hidden bg-background">
    {#if mobileNavigationOpen}
      <button
        class="fixed inset-0 z-30 bg-black/60 md:hidden"
        aria-label="Close navigation"
        onclick={() => {
          mobileNavigationOpen = false;
        }}
      ></button>
    {/if}
    <!--
    {#if mobileMembersOpen}
      <button
        class="fixed inset-0 z-30 bg-black/60 lg:hidden"
        aria-label="Close member list"
        onclick={() => (mobileMembersOpen = false)}
      ></button>
    {/if}
-->
    <div
      class="fixed inset-y-0 left-0 z-40 flex max-w-[calc(100vw-3rem)] shrink-0 flex-col bg-sidebar transition-transform md:static md:z-auto md:max-w-none md:translate-x-0"
      class:-translate-x-full={!mobileNavigationOpen}
    >
      <div class="flex min-h-0 flex-1">
        <ServerSidebar
          servers={chat.servers}
          activeId={chat.activeServer}
          mentions={guildMentions}
          {hasUnreadDms}
          onSelect={selectServer}
          onCreateServer={(server) => chat.createServer(server)}
          onReorder={async (guilds) => await chat.reorderGuilds(guilds)}
        />
        {#if currentServer}
          <ChannelSidebar
            server={currentServer}
            categories={currentCategories}
            activeChannel={chat.activeChannel}
            onSelectChannel={selectChannel}
            onCreateChannel={async (channel: Channel) =>
              await chat.createChannel(
                currentServer.id,
                channel,
                channel.type === 'VOICE' ? 'VOICE' : 'TEXT'
              )}
            onReorderChannels={(channelIds) => chat.reorderChannels(currentServer.id, channelIds)}
            onSaveChannelOrder={async (channelIds) =>
              await chat.saveChannelOrder(currentServer.id, channelIds)}
            canReorder={currentServer.canManageChannels}
            {voice}
            members={chat.members}
            voiceStates={chat.voiceStates}
          />
        {/if}
        {#if chat.route.kind === 'home' || chat.route.kind === 'dms'}
          <DmSidebar />
        {/if}
      </div>
      <UserArea {voice} user={currentUser} {voiceChannelName} onLeaveVoice={leaveVoice} />
    </div>

    {#if chat.route.kind === 'home'}
      <FriendsHome onOpenNavigation={() => (mobileNavigationOpen = true)} />
    {:else if currentChannel && (currentChannel.type === 'TEXT' || currentChannel.type === 'DM')}
      <ChatArea
        channel={currentChannel}
        messages={currentMessages}
        loading={currentMessagesLoading}
        onSend={(content, files, replyTo) =>
          chat.sendMessage(currentChannel.id, content, files, replyTo)}
        onDelete={(messageId) => chat.deleteMessage(currentChannel.id, messageId)}
        onEdit={(messageId, content) => chat.editMessage(currentChannel.id, messageId, content)}
        onOpenNavigation={() => (mobileNavigationOpen = true)}
        onOpenMembers={() => (mobileMembersOpen = true)}
        onCall={() => startCall(currentChannel.id)}
        call={currentChannel.type === 'DM' && voice.channelId === currentChannel.id
          ? dmCall
          : undefined}
        {callExpanded}
      />
      {#snippet dmCall()}
        <VoiceArea
          channel={currentChannel!}
          {voice}
          members={callMembers}
          onJoin={() => startCall(currentChannel!.id)}
          onLeave={() => {
            callExpanded = false;
            leaveVoice();
          }}
          embedded
          expanded={callExpanded}
          onToggleExpand={() => (callExpanded = !callExpanded)}
        />
      {/snippet}
    {:else if currentChannel && currentChannel.type === 'VOICE'}
      <VoiceArea
        channel={currentChannel}
        {voice}
        members={chat.members}
        onJoin={() => voice.join(currentChannel.id).catch(() => null)}
        onLeave={leaveVoice}
        onOpenNavigation={() => (mobileNavigationOpen = true)}
        onOpenMembers={() => (mobileMembersOpen = true)}
      />
    {:else}
      <main class="relative flex min-w-0 flex-1 items-center justify-center bg-background px-6">
        <button
          class="absolute top-3 left-3 min-h-10 border border-border px-3 text-sm font-medium md:hidden"
          onclick={() => (mobileNavigationOpen = true)}
        >
          Browse channels
        </button>
        <div class="max-w-sm text-center">
          {#if chat.route.kind === 'dms'}
            <p class="text-sm font-medium text-foreground">No conversation selected</p>
            <p class="mt-1 text-sm text-muted-foreground">Pick a direct message to begin.</p>
          {:else}
            <p class="text-sm font-medium text-foreground">No channel selected</p>
            <p class="mt-1 text-sm text-muted-foreground">Pick a server or create one to begin.</p>
          {/if}
        </div>
      </main>
    {/if}
    {#if chat.route.kind === 'guild'}
      <div
        class="fixed inset-y-0 right-0 z-40 w-56 transition-transform lg:static lg:z-auto lg:translate-x-0"
        class:translate-x-full={!mobileMembersOpen}
      >
        <!--
        <button
          class="absolute top-1.5 right-2 z-10 flex size-9 items-center justify-center text-muted-foreground hover:text-foreground lg:hidden"
          aria-label="Close member list"
          onclick={() => (mobileMembersOpen = false)}
        >
          <X class="size-5" />
        </button>
        -->
        <MemberSidebar server={currentServer!} members={chat.members} />
      </div>
    {/if}
  </div>
{/if}
