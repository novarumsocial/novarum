<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { useSession } from '$lib/session.svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { realtime } from '$lib/realtime.svelte';
  import { Voice } from '$lib/voice.svelte';
  import ServerSidebar from './guild-sidebar.svelte';
  import ChannelSidebar from './channel-sidebar.svelte';
  import ChatArea from './chat-area.svelte';
  import VoiceArea from './voice-area.svelte';
  import InitialLoader from './initial-loader.svelte';
  import MemberSidebar from './member-sidebar.svelte';
  import type { Channel } from '$lib/types/chat';
  import UserArea from './user-area.svelte';
  import { X } from '@lucide/svelte';

  const session = useSession();

  const currentUser = $derived(session.user);
  let booting = $state(true);
  let mobileNavigationOpen = $state(false);
  let mobileMembersOpen = $state(false);

  const currentServer = $derived(chat.currentServer);
  const currentCategories = $derived(chat.currentCategories);
  const currentChannel = $derived(chat.currentChannel);
  const currentMessages = $derived(chat.currentMessages);
  const currentMessagesLoading = $derived(chat.currentMessagesLoading);

  const voice = new Voice();
  let joinedVoiceChannelId = $state<string | null>(null);
  let dismissedVoiceChannelId = $state<string | null>(null);

  const voiceChannelName = $derived(
    Object.values(chat.channelsByServer)
      .flatMap((categories) => categories)
      .flatMap((category) => category.channels)
      .find((channel) => channel.id === voice.channelId)?.name ?? null
  );

  // Join voice channels when selected; keep the call alive while browsing text channels.
  $effect(() => {
    const channelId = currentChannel?.type === 'VOICE' ? currentChannel.id : null;
    const userId = currentUser?.id ?? null;

    if (!channelId || !userId) {
      return;
    }

    if (joinedVoiceChannelId !== channelId && dismissedVoiceChannelId !== channelId) {
      joinedVoiceChannelId = channelId;
      void voice.join(channelId).catch(() => null);
    }
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

    await chat.loadInitialData();
    booting = false;
  }

  function leaveVoice() {
    dismissedVoiceChannelId = voice.channelId;
    joinedVoiceChannelId = null;
    void voice.leave();
  }

  function selectServer(id: string) {
    chat.selectServer(id);
  }

  function selectChannel(id: string) {
    if (
      currentCategories.some((category) =>
        category.channels.some((channel) => channel.id === id && channel.type === 'VOICE')
      )
    ) {
      dismissedVoiceChannelId = null;
      joinedVoiceChannelId = null;
    }
    chat.selectChannel(id);
    mobileNavigationOpen = false;
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

{#if booting}
  <InitialLoader />
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
    {#if mobileMembersOpen}
      <button
        class="fixed inset-0 z-30 bg-black/60 lg:hidden"
        aria-label="Close member list"
        onclick={() => (mobileMembersOpen = false)}
      ></button>
    {/if}

    <div
      class="fixed inset-y-0 left-0 z-40 flex max-w-[calc(100vw-3rem)] shrink-0 flex-col bg-sidebar transition-transform md:static md:z-auto md:max-w-none md:translate-x-0"
      class:-translate-x-full={!mobileNavigationOpen}
    >
      <div class="flex min-h-0 flex-1">
        <ServerSidebar
          servers={chat.servers}
          activeId={chat.activeServer}
          onSelect={selectServer}
          onCreateServer={(server) => chat.createServer(server)}
        />
        {#if currentServer}
          <ChannelSidebar
            server={currentServer}
            categories={currentCategories}
            activeChannel={chat.activeChannel}
            onSelectChannel={selectChannel}
            onCreateChannel={async (channel: Channel) =>
              await chat.createChannel(currentServer.id, channel, channel.type)}
            {voice}
            members={chat.members}
            voiceStates={chat.voiceStates}
          />
        {/if}
      </div>
      <UserArea {voice} user={currentUser} {voiceChannelName} onLeaveVoice={leaveVoice} />
    </div>

    {#if currentChannel && currentChannel.type === 'TEXT'}
      <ChatArea
        channel={currentChannel}
        messages={currentMessages}
        loading={currentMessagesLoading}
        onSend={(content, files, replyTo) =>
          chat.sendMessage(currentChannel.id, content, files, replyTo)}
        onDelete={(messageId) => chat.deleteMessage(currentChannel.id, messageId)}
        onOpenNavigation={() => (mobileNavigationOpen = true)}
        onOpenMembers={() => (mobileMembersOpen = true)}
      />
    {:else if currentChannel && currentChannel.type === 'VOICE'}
      <VoiceArea
        channel={currentChannel}
        {voice}
        members={chat.members}
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
          <p class="text-sm font-medium text-foreground">No channel selected</p>
          <p class="mt-1 text-sm text-muted-foreground">Pick a server or create one to begin.</p>
        </div>
      </main>
    {/if}
    <div
      class="fixed inset-y-0 right-0 z-40 w-56 transition-transform lg:static lg:z-auto lg:translate-x-0"
      class:translate-x-full={!mobileMembersOpen}
    >
      <button
        class="absolute top-1.5 right-2 z-10 flex size-9 items-center justify-center text-muted-foreground hover:text-foreground lg:hidden"
        aria-label="Close member list"
        onclick={() => (mobileMembersOpen = false)}
      >
        <X class="size-5" />
      </button>
      <MemberSidebar members={chat.members} />
    </div>
  </div>
{/if}
