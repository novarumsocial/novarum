<script lang="ts">
  import { Bot, Hash, Users } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat-state.svelte';
  import { listConversations } from '$lib/conversations.svelte';
  import * as Command from '$lib/components/ui/command/index.js';
  import Avatar from './avatar.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const conversations = $derived(open ? listConversations() : []);
  const direct = $derived(conversations.filter((item) => !item.server));
  const servers = $derived(
    chat.servers
      .map((server) => ({
        server,
        channels: conversations.filter((item) => item.server?.id === server.id),
      }))
      .filter((group) => group.channels.length > 0)
  );

  function jump(action: () => unknown) {
    open = false;
    void action();
  }
</script>

<Command.Dialog
  bind:open
  title="Jump to"
  description="Search your channels and direct messages"
  class="sm:max-w-xl"
>
  <Command.Input placeholder="Jump to a channel or person" />
  <Command.List class="max-h-96">
    <Command.Empty>Nothing matches that. Try a channel, server or person's name.</Command.Empty>

    {#if direct.length}
      <Command.Group heading="Direct messages">
        {#each direct as item (item.id)}
          <Command.Item
            value={item.id}
            keywords={[item.name]}
            onSelect={() => jump(() => chat.selectChannel(item.id))}
          >
            <Avatar
              src={item.avatarUrl}
              name={item.name}
              class="size-5 text-[10px]"
              bgColor={item.avatarColor}
            />
            <span class="truncate" class:font-semibold={item.unread}>{item.name}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#each servers as { server, channels } (server.id)}
      <Command.Group heading={server.name}>
        {#each channels as item (item.id)}
          <Command.Item
            value={item.id}
            keywords={[item.name, server.name]}
            onSelect={() => jump(() => chat.selectChannel(item.id))}
          >
            <Hash class="size-4 text-muted-foreground" />
            <span class="truncate" class:font-semibold={item.unread || item.mention > 0}>
              {item.name}
            </span>
            {#if item.mention > 0}
              <span
                class="ml-auto bg-destructive px-1 text-[10px] font-bold text-destructive-foreground"
              >
                {item.mention}
              </span>
            {/if}
          </Command.Item>
        {/each}
      </Command.Group>
    {/each}

    <Command.Group heading="Go to">
      <Command.Item value="friends" onSelect={() => jump(() => goto('/guilds'))}>
        <Users class="size-4 text-muted-foreground" />
        Friends
      </Command.Item>
      <Command.Item value="developers" onSelect={() => jump(() => goto('/guilds/developers'))}>
        <Bot class="size-4 text-muted-foreground" />
        Developers
      </Command.Item>
    </Command.Group>
  </Command.List>
</Command.Dialog>
