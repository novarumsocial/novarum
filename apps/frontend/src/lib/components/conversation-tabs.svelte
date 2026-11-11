<script lang="ts">
  import { Hash, X } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat-state.svelte';
  import { listConversations } from '$lib/conversations.svelte';
  import { tabs } from '$lib/tabs.svelte';
  import Avatar from './avatar.svelte';

  const byId = $derived(new Map(listConversations().map((item) => [item.id, item])));
  const open = $derived(tabs.ids.flatMap((id) => byId.get(id) ?? []));

  // every conversation you visit becomes a tab; only the route is tracked so closing one sticks
  $effect(() => {
    const id = chat.activeChannel;
    untrack(() => {
      if (id && chat.currentChannel?.type !== 'VOICE') tabs.open(id);
    });
  });

  function close(id: string) {
    const index = open.findIndex((item) => item.id === id);
    const next = open[index + 1] ?? open[index - 1];
    tabs.close(id);
    if (chat.activeChannel !== id) return;
    if (next) void chat.selectChannel(next.id);
    else void goto('/guilds');
  }

  function onKeydown(event: KeyboardEvent) {
    const target = open[Number(event.key) - 1];
    if (!event.altKey || event.ctrlKey || event.metaKey || !target) return;
    event.preventDefault();
    void chat.selectChannel(target.id);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]"
  role="tablist"
  aria-label="Open conversations"
>
  {#each open as item, index (item.id)}
    {@const active = chat.activeChannel === item.id}
    <div
      class="group relative flex h-8 max-w-56 min-w-24 shrink items-center rounded-pill border text-sm transition-colors {active
        ? 'border-transparent bg-sidebar-accent font-medium text-sidebar-accent-foreground'
        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'}"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title="{item.server ? `#${item.name} in ${item.server.name}` : item.name}{index < 9
          ? ` (Alt+${index + 1})`
          : ''}"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-pill pr-1 pl-3 text-left outline-none focus-visible:bg-accent"
        onclick={() => chat.selectChannel(item.id)}
        onauxclick={(event) => event.button === 1 && close(item.id)}
      >
        {#if item.server}
          <Hash class="size-3.5 shrink-0 opacity-70" />
        {:else}
          <Avatar
            src={item.avatarUrl}
            name={item.name}
            class="size-4 text-[9px]"
            bgColor={item.avatarColor}
          />
        {/if}
        <span
          class="max-w-36 shrink-0 truncate"
          class:font-semibold={item.unread || item.mention > 0}
        >
          {item.name}
        </span>
        {#if item.server}
          <span class="min-w-0 truncate text-xs font-normal opacity-70">
            {item.server.name}
          </span>
        {/if}
      </button>

      <span class="relative mr-1.5 flex size-5 shrink-0 items-center justify-center">
        {#if item.mention > 0}
          <span
            class="flex h-4.5 min-w-4.5 items-center justify-center rounded-pill bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground group-hover:invisible"
          >
            {item.mention > 99 ? '99+' : item.mention}
          </span>
        {:else if item.unread}
          <span class="size-2 rounded-pill bg-tertiary group-hover:invisible"></span>
        {/if}
        <button
          type="button"
          class="absolute inset-0 flex cursor-pointer items-center justify-center rounded-pill opacity-0 group-hover:opacity-70 hover:bg-foreground/10 hover:opacity-100 focus-visible:opacity-100"
          aria-label="Close {item.name}"
          onclick={() => close(item.id)}
        >
          <X class="size-3.5" />
        </button>
      </span>
    </div>
  {/each}
</div>
