<script lang="ts">
  import { Hash, X } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat-state.svelte';
  import { listConversations } from '$lib/conversations.svelte';
  import { settings } from '$lib/settings.svelte';
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
  class="flex min-w-0 flex-1 items-end self-stretch overflow-x-auto [scrollbar-width:none]"
  role="tablist"
  aria-label="Open conversations"
>
  {#each open as item, index (item.id)}
    {@const active = chat.activeChannel === item.id}
    <div
      class="group relative flex h-9 max-w-56 min-w-24 shrink items-center border border-b-0 text-sm {active
        ? 'border-border bg-background text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'}"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title="{item.server ? `#${item.name} in ${item.server.name}` : item.name}{index < 9
          ? ` (Alt+${index + 1})`
          : ''}"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pr-1 pl-3 text-left outline-none focus-visible:bg-muted"
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
        <span class="truncate" class:font-semibold={item.unread || item.mention > 0}>
          {item.name}
        </span>
        {#if item.server}
          <span class="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">
            {item.server.name}
          </span>
        {/if}
      </button>

      <span class="relative mr-2 flex size-5 shrink-0 items-center justify-center">
        {#if item.mention > 0}
          <span
            class="flex h-4 min-w-4 items-center justify-center bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground group-hover:invisible"
            class:rounded-full={settings.value.circleIcons}
          >
            {item.mention > 99 ? '99+' : item.mention}
          </span>
        {:else if item.unread}
          <span
            class="size-2 bg-foreground group-hover:invisible"
            class:rounded-full={settings.value.circleIcons}
          ></span>
        {/if}
        <button
          type="button"
          class="absolute inset-0 flex cursor-pointer items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
          aria-label="Close {item.name}"
          onclick={() => close(item.id)}
        >
          <X class="size-3.5" />
        </button>
      </span>
    </div>
  {/each}
</div>
