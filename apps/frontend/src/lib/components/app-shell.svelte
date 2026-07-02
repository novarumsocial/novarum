<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { anchor } from '$lib/anchor.svelte';
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

  type MeData = Awaited<ReturnType<typeof anchor.client.auth.me.get>>['data'];

  let currentUser = $state<MeData | null>(null);
  let booting = $state(true);

  const currentServer = $derived(chat.currentServer);
  const currentCategories = $derived(chat.currentCategories);
  const currentChannel = $derived(chat.currentChannel);
  const currentMessages = $derived(chat.currentMessages);
  const currentMessagesLoading = $derived(chat.currentMessagesLoading);

  const voice = new Voice();
  let joinedVoiceChannelId: string | null = null;

  // auto-join/leave voice when channel type changes
  $effect(() => {
    const channelId = currentChannel?.type === 'VOICE' ? currentChannel.id : null;
    const userId = currentUser?.user.id ?? null;

    if (!channelId || !userId) {
      if (joinedVoiceChannelId) {
        joinedVoiceChannelId = null;
        void voice.leave();
      }
      return;
    }

    if (joinedVoiceChannelId !== channelId) {
      joinedVoiceChannelId = channelId;
      void voice.join(channelId).catch(() => null);
    }
  });

  $effect(() => {
    if (!booting) chat.syncActiveChannel();
  });

  async function boot() {
    const me = await anchor.client.auth.me.get();

    currentUser = me.data ?? null;

    if (!currentUser) {
      await goto('/login');
      return;
    }

    await chat.loadInitialData();
    booting = false;
  }

  function leaveVoice() {
    joinedVoiceChannelId = null;
    void voice.leave();
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
  <div class="dark flex h-svh overflow-hidden bg-background">
    <div class="flex shrink-0 flex-col">
      <div class="flex min-h-0 flex-1">
        <ServerSidebar
          servers={chat.servers}
          activeId={chat.activeServer}
          onSelect={(id) => chat.selectServer(id)}
          onCreateServer={(server) => chat.createServer(server)}
        />
        {#if currentServer}
          <ChannelSidebar
            server={currentServer}
            categories={currentCategories}
            activeChannel={chat.activeChannel}
            onSelectChannel={(id: string) => chat.selectChannel(id)}
            onCreateChannel={async (channel: Channel) =>
              await chat.createChannel(currentServer.id, channel, channel.type)}
          />
        {/if}
      </div>
      <UserArea {voice} user={currentUser.user} />
    </div>

    {#if currentChannel && currentChannel.type === "TEXT"}
      <ChatArea
        channel={currentChannel}
        messages={currentMessages}
        loading={currentMessagesLoading}
        onSend={(content) => chat.sendMessage(currentChannel.id, content)}
      />
    {:else if currentChannel && currentChannel.type === "VOICE"}
      <VoiceArea channel={currentChannel} {voice} onLeave={leaveVoice} />
    {:else}
      <main class="flex flex-1 items-center justify-center bg-background px-6">
        <div class="max-w-sm text-center">
          <p class="text-sm font-medium text-foreground">No channel selected</p>
          <p class="mt-1 text-sm text-muted-foreground">Pick a server or create one to begin.</p>
        </div>
      </main>
    {/if}
    <MemberSidebar members={chat.members} voiceUsers={chat.voiceUsers} {voice} />
  </div>
{/if}
