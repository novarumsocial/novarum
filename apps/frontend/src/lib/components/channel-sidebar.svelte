<script lang="ts">
  import { cn } from "$lib/utils";
  import {
    Hash, Volume2, Globe, ChevronDown, ChevronRight,
    Plus, User, Settings, Headphones, Mic, MicOff,
    HeadphoneOff,
  } from "@lucide/svelte";
  import type { Server, ChannelCategory, Channel } from "$lib/data/mock";
  import UserArea from "./user-area.svelte";

  let {
    server,
    categories,
    activeChannel,
    onSelectChannel,
  }: {
    server: Server;
    categories: ChannelCategory[];
    activeChannel: string;
    onSelectChannel: (id: string) => void;
  } = $props();

  let collapsed = $state<Record<string, boolean>>({});
</script>

<aside class="flex w-60 flex-col bg-sidebar">
  <!-- server header -->
  <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
    <span class="truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
      {server.name}
    </span>
    <button class="shrink-0 text-muted-foreground transition-colors hover:text-foreground" aria-label="Server settings">
      <ChevronDown class="size-4" />
    </button>
  </div>

  <!-- channel list -->
  <div class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
    {#each categories as cat}
      <button
        onclick={() => {
          collapsed[cat.id] = !collapsed[cat.id];
          collapsed = { ...collapsed };
        }}
        class="flex w-full items-center gap-1 px-1 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-sidebar-foreground"
      >
        {#if collapsed[cat.id]}
          <ChevronRight class="size-3 shrink-0" />
        {:else}
          <ChevronDown class="size-3 shrink-0" />
        {/if}
        {cat.label}
        <span
          onclick={(e) => { e.stopPropagation(); }}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
          class="ml-auto cursor-pointer opacity-0 transition-opacity hover:opacity-100"
          role="button"
          tabindex="-1"
          aria-label="Add channel"
        >
          <Plus class="size-3" />
        </span>
      </button>

      {#if !collapsed[cat.id]}
        {#each cat.channels as ch}
          <button
            onclick={() => onSelectChannel(ch.id)}
            class={cn(
              "flex w-full items-center gap-1.5 rounded-none px-2 py-1 text-left text-sm transition-colors",
              activeChannel === ch.id && "bg-primary/10 text-sidebar-foreground",
              activeChannel !== ch.id && "text-muted-foreground hover:text-sidebar-foreground",
            )}
          >
            {#if ch.type === "voice"}
              <Volume2 class="size-4 shrink-0" />
            {:else if ch.type === "federated"}
              <Globe class="size-4 shrink-0 text-primary/70" />
            {:else}
              <Hash class="size-4 shrink-0" />
            {/if}
            <span class="flex-1 truncate">{ch.label || ch.name}</span>
            {#if ch.mention > 0}
              <span class="flex size-5 shrink-0 items-center justify-center bg-destructive text-[11px] font-bold text-destructive-foreground">
                {ch.mention}
              </span>
            {/if}
            {#if ch.unread && ch.mention === 0}
              <span class="size-2 shrink-0 rounded-none bg-foreground/60"></span>
            {/if}
          </button>
        {/each}
      {/if}

      {#if cat.channels.length > 0}
        <div class="h-1"></div>
      {/if}
    {/each}
  </div>
  
  <UserArea />
</aside>
