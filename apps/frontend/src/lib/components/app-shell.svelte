<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { useSession } from '$lib/session.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { realtime } from '$lib/realtime.svelte';
  import { friends } from '$lib/friends.svelte';
  import { dms, dmPath } from '$lib/dms.svelte';
  import { device } from '$lib/device.svelte';
  import { settings } from '$lib/settings.svelte';
  import { syncPush, watchNotificationTaps } from '$lib/push';
  import { notificationSettings } from '$lib/notification-settings.svelte';
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
  import DevelopersHome from './developers-home.svelte';
  import DmSidebar from './dm-sidebar.svelte';
  import CallRinging from './call-ringing.svelte';
  import ConversationTabs from './conversation-tabs.svelte';
  import QuickSwitcher from './quick-switcher.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Mic, MicOff, PanelLeft, Search } from '@lucide/svelte';
  import type { Server } from '$lib/types/chat';
  import { ConnectionState } from 'livekit-client';

  const session = useSession();

  const currentUser = $derived(session.user);
  let booting = $state(true);
  let bootFinished = $state(false);
  let mobileNavigationOpen = $state(false);
  let mobileMembersOpen = $state(false);
  let switcherOpen = $state(false);
  const switcherKeys = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

  function onKeydown(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    switcherOpen = !switcherOpen;
  }
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
          .reduce(
            (sum, channel) =>
              notificationSettings.showsMentions({ channelId: channel.id, guildId })
                ? sum + channel.mention
                : sum,
            0
          ),
      ])
    )
  );
  const unreadDms = $derived(
    dms.list
      .filter(
        (dm) => dm.unread && notificationSettings.showsUnread({ channelId: dm.id, guildId: null })
      )
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
  );

  // shown in the tab title and, on desktop, as the app badge
  const unreadTotal = $derived(
    Object.values(guildMentions).reduce((sum, count) => sum + count, 0) + unreadDms.length
  );

  // push subscriptions go stale (endpoints change, sessions get replaced), so renew them once per start
  let pushSynced = false;
  $effect(() => {
    if (booting || pushSynced || !settings.value.pushNotifications) return;
    pushSynced = true;
    void syncPush();
  });

  $effect(() => watchNotificationTaps((url) => void goto(url)));

  $effect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) Novarum` : 'Novarum';
    void window.electron?.setBadgeCount(unreadTotal);
  });

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
    const ring = !chat.voiceStates[id]?.length;
    void voice
      .join(id)
      .then(() => {
        if (ring && voice.channelId === id) realtime.ringCall(id);
      })
      .catch(() => null);
  }

  const voiceChannelName = $derived(
    Object.values(chat.channelsByServer)
      .flatMap((categories) => categories)
      .flatMap((category) => category.channels)
      .find((channel) => channel.id === voice.channelId)?.name ??
      (voice.channelId ? dms.get(voice.channelId)?.participants[0]?.username : null) ??
      null
  );

  // a voice channel's call takes the whole width, so it has no member list
  const showMembers = $derived(chat.route.kind === 'guild' && currentChannel?.type !== 'VOICE');
  $effect(() => {
    if (!showMembers) mobileMembersOpen = false;
  });

  $effect(() => {
    if (!booting) chat.syncActiveChannel();
  });

  async function boot() {
    const user = await session.refresh();

    if (!user) {
      await goto('/login');
      return;
    }

    await Promise.all([chat.loadInitialData(), friends.load(), notificationSettings.load()]);
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

  // the sidebar lists every server's channels, so the channel may belong to any of them
  function selectChannel(id: string) {
    const channel = Object.values(chat.channelsByServer)
      .flat()
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
    else if (x < 0 && window.innerWidth < 1024 && showMembers) {
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

  function toggleMembers() {
    if (window.innerWidth >= 1024) settings.value.showMemberList = !settings.value.showMemberList;
    else openMembers();
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
  onkeydown={onKeydown}
  ontouchstart={startSwipe}
  ontouchend={finishSwipe}
  ontouchcancel={() => (swipeStart = null)}
/>

{#if booting}
  <InitialLoader finished={bootFinished} />
{:else if currentUser}
  <div class="flex h-svh overflow-hidden bg-sidebar">
    {#if mobileNavigationOpen}
      <button
        class="fixed inset-0 z-30 bg-black/60 md:hidden"
        aria-label="Close navigation"
        onclick={() => {
          mobileNavigationOpen = false;
        }}
      ></button>
    {/if}
    {#if mobileMembersOpen}
      <button
        class="fixed inset-0 z-30 bg-black/60 lg:hidden"
        aria-label="Close member list"
        onclick={() => (mobileMembersOpen = false)}
      ></button>
    {/if}
    <div
      class="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[calc(100vw-3rem)] shrink-0 flex-col bg-sidebar transition-transform md:static md:z-auto md:translate-x-0 {settings
        .value.showSidebar
        ? ''
        : 'md:hidden'}"
      class:-translate-x-full={!mobileNavigationOpen}
    >
      <!-- one tree for everything: direct messages first, then every server with its channels -->
      <div class="min-h-0 flex-1 overflow-y-auto pb-2">
        <DmSidebar onCall={startCall} />
        <ServerSidebar
          servers={chat.servers}
          activeId={chat.activeServer}
          channels={serverChannels}
          onCreateServer={(server) => chat.createServer(server)}
          onReorder={async (guilds) => await chat.reorderGuilds(guilds)}
        />
      </div>
      <UserArea {voice} user={currentUser} {voiceChannelName} onLeaveVoice={leaveVoice} />
    </div>
    {#snippet serverChannels(server: Server, expanded: boolean, toggle: () => void)}
      <ChannelSidebar
        {server}
        categories={chat.channelsByServer[server.id] ?? []}
        activeChannel={chat.activeChannel}
        onSelectChannel={selectChannel}
        onCreateChannel={async (channel: Channel) =>
          await chat.createChannel(server.id, channel, channel.type === 'VOICE' ? 'VOICE' : 'TEXT')}
        onReorderChannels={(channelIds) => chat.reorderChannels(server.id, channelIds)}
        onSaveChannelOrder={async (channelIds) =>
          await chat.saveChannelOrder(server.id, channelIds)}
        onSetOwnerOnly={(channelId, ownerOnly) =>
          void chat.setOwnerOnly(server.id, channelId, ownerOnly)}
        folded={!expanded}
        onToggleFold={toggle}
        canReorder={server.canManageChannels}
        {voice}
        members={chat.members}
        voiceStates={chat.voiceStates}
      />
    {/snippet}

    <div class="flex min-w-0 flex-1 flex-col">
      <!-- open conversations as tabs; the active one joins the panel below it -->
      <div
        class="hidden h-14 shrink-0 items-center gap-2 pr-3 md:flex {settings.value.showSidebar
          ? ''
          : 'pl-3'}"
      >
        <Button
          variant="ghost"
          size="icon"
          class="text-muted-foreground"
          aria-label={settings.value.showSidebar ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={settings.value.showSidebar}
          title={settings.value.showSidebar ? 'Hide sidebar' : 'Show sidebar'}
          onclick={() => (settings.value.showSidebar = !settings.value.showSidebar)}
        >
          <PanelLeft class="size-4" />
        </Button>
        <ConversationTabs />
        {#if voice.connected && !settings.value.showSidebar}
          <Button
            variant="ghost"
            size="icon"
            class={voice.selfMuted ? 'text-rose-400' : 'text-muted-foreground'}
            aria-label={voice.selfMuted ? 'Unmute' : 'Mute'}
            title={voice.selfMuted ? 'Unmute' : 'Mute'}
            onclick={() => voice.setMuted(!voice.selfMuted)}
          >
            {#if voice.selfMuted}<MicOff class="size-4" />{:else}<Mic class="size-4" />{/if}
          </Button>
        {/if}
        <button
          type="button"
          class="flex h-9 w-60 shrink-0 cursor-pointer items-center gap-2.5 rounded-pill bg-card px-4 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onclick={() => (switcherOpen = true)}
        >
          <Search class="size-3.5 shrink-0" />
          <span class="flex-1 text-left">Jump to</span>
          <kbd class="font-sans text-xs">{switcherKeys}</kbd>
        </button>
      </div>

      <div
        class="flex min-h-0 flex-1 overflow-hidden bg-background md:mr-3 md:mb-3 md:rounded-3xl {settings
          .value.showSidebar
          ? ''
          : 'md:ml-3'}"
      >
        {#if chat.route.kind === 'home'}
          <FriendsHome onOpenNavigation={() => (mobileNavigationOpen = true)} />
        {:else if chat.route.kind === 'developers'}
          <DevelopersHome onOpenNavigation={() => (mobileNavigationOpen = true)} />
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
            onToggleMembers={toggleMembers}
            onCall={() => startCall(currentChannel.id)}
            onRing={() => realtime.ringCall(currentChannel.id)}
            onProfileCall={startCall}
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
                <p class="mt-1 text-sm text-muted-foreground">
                  Pick a server or create one to begin.
                </p>
              {/if}
            </div>
          </main>
        {/if}
        {#if showMembers}
          <div
            class="fixed inset-y-0 right-0 z-40 w-56 transition-transform lg:static lg:z-auto lg:translate-x-0 {settings
              .value.showMemberList
              ? ''
              : 'lg:hidden'}"
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
            <MemberSidebar server={currentServer!} members={chat.members} onCall={startCall} />
          </div>
        {/if}
      </div>
    </div>
  </div>
  <QuickSwitcher bind:open={switcherOpen} />
  <CallRinging
    {voice}
    onAccept={(id) => {
      void goto(dmPath(id));
      startCall(id);
    }}
  />
{/if}
