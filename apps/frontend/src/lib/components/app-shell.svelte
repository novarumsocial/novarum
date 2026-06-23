<script lang="ts">
  import { onMount } from 'svelte';
  import { chat } from '$lib/chat-state.svelte';
  import { realtime } from '$lib/realtime.svelte';
  import ServerSidebar from './guild-sidebar.svelte';
  import ChannelSidebar from './channel-sidebar.svelte';
  import ChatArea from './chat-area.svelte';
  import MemberSidebar from './member-sidebar.svelte';
  import type { Channel } from '$lib/types/chat';
  import UserArea from './user-area.svelte';

  const currentServer = $derived(chat.currentServer);
  const currentCategories = $derived(chat.currentCategories);
  const currentChannel = $derived(chat.currentChannel);
  const currentMessages = $derived(chat.currentMessages);
  const currentMessagesLoading = $derived(chat.currentMessagesLoading);

  $effect(() => chat.syncActiveChannel());

  onMount(() => {
    const disconnect = realtime.connect();
    chat.loadGuilds();

    return disconnect;
  });
</script>

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
    <UserArea />
  </div>

  {#if currentChannel}
    <ChatArea
      channel={currentChannel}
      messages={currentMessages}
      loading={currentMessagesLoading}
      onSend={(content) => chat.sendMessage(currentChannel.id, content)}
    />
  {:else}
    <main class="flex flex-1 items-center justify-center bg-background px-6">
      <div class="max-w-sm text-center">
        <p class="text-sm font-medium text-foreground">No channel selected</p>
        <p class="mt-1 text-sm text-muted-foreground">Pick a server or create one to begin.</p>
      </div>
    </main>
  {/if}
  <MemberSidebar members={chat.members} voiceUsers={chat.voiceUsers} />
</div>
