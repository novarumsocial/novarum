<script lang="ts">
  import { Bell, BellOff } from '@lucide/svelte';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { notificationSettings } from '$lib/notification-settings.svelte';
  import type { NotificationLevel } from 'anchor/notification-level';

  // the "Mute" and "Notify" entries of a right-click menu, for a guild, channel or DM.
  let {
    targetId,
    guildId = null,
    noun,
  }: { targetId: string; guildId?: string | null; noun: 'Server' | 'Channel' | 'Conversation' } =
    $props();

  // a guild is its own parent here, so it falls back to the guild default (mentions)
  const level = $derived(
    notificationSettings.level({ channelId: targetId, guildId: noun === 'Server' ? targetId : guildId })
  );
  const muted = $derived(notificationSettings.isMuted(targetId));
  const hasSetting = $derived(!!notificationSettings.entries[targetId]);

  const mutes: [string, number | null][] = [
    ['For 1 Hour', 1],
    ['For 8 Hours', 8],
    ['For 24 Hours', 24],
    ['Until I turn it back on', null],
  ];
</script>

<ContextMenu.Sub>
  <ContextMenu.SubTrigger>
    <BellOff class="size-4" />
    {muted ? `Muted ${noun}` : `Mute ${noun}`}
  </ContextMenu.SubTrigger>
  <ContextMenu.SubContent>
    {#if muted}
      <ContextMenu.Item onclick={() => notificationSettings.unmute(targetId, level)}>
        Unmute
      </ContextMenu.Item>
    {/if}
    {#each mutes as [label, hours] (label)}
      <ContextMenu.Item onclick={() => notificationSettings.mute(targetId, hours, level)}>
        {label}
      </ContextMenu.Item>
    {/each}
  </ContextMenu.SubContent>
</ContextMenu.Sub>

<ContextMenu.Sub>
  <ContextMenu.SubTrigger>
    <Bell class="size-4" />
    Notify
  </ContextMenu.SubTrigger>
  <ContextMenu.SubContent>
    <ContextMenu.RadioGroup
      value={level}
      onValueChange={(value) =>
        notificationSettings.set(targetId, { level: value as NotificationLevel }, level)}
    >
      <ContextMenu.RadioItem value="ALL">All Messages</ContextMenu.RadioItem>
      <ContextMenu.RadioItem value="MENTIONS">Only Mentions</ContextMenu.RadioItem>
      <ContextMenu.RadioItem value="NONE">Nothing</ContextMenu.RadioItem>
    </ContextMenu.RadioGroup>
    {#if hasSetting}
      <ContextMenu.Separator />
      <ContextMenu.Item onclick={() => notificationSettings.reset(targetId)}>
        Use Default
      </ContextMenu.Item>
    {/if}
  </ContextMenu.SubContent>
</ContextMenu.Sub>
