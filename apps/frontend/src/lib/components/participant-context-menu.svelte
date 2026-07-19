<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Voice } from '$lib/voice.svelte';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';

  let {
    voice,
    identity,
    name,
    children,
  }: {
    voice?: Voice | null;
    identity: string;
    name: string;
    children: Snippet;
  } = $props();
</script>

{#if voice && voice.connected}
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {@render children()}
    </ContextMenu.Trigger>
    <ContextMenu.Content class="overflow-y-hidden">
      {#if identity === voice?.localIdentity}
        <ContextMenu.CheckboxItem
          closeOnSelect={false}
          checked={voice.selfMuted}
          onCheckedChange={(muted) => voice?.setMuted(muted)}>Mute</ContextMenu.CheckboxItem
        >
      {:else}
        <ContextMenu.CheckboxItem
          closeOnSelect={false}
          checked={voice?.participantMuted(identity) ?? false}
          onCheckedChange={(muted) => voice?.setParticipantMuted(identity, muted)}
          >Local mute</ContextMenu.CheckboxItem
        >
        <ContextMenu.Item closeOnSelect={false} class="w-48 flex-col items-start gap-2">
          <p class="flex w-full justify-between">
            <span>Volume</span>
            <span>{Math.round((voice?.participantVolume(identity) ?? 1) * 100)}%</span>
          </p>
          <Slider
            type="single"
            aria-label={`Volume for ${name}`}
            min={0}
            max={300}
            step={1}
            value={(voice?.participantVolume(identity) ?? 1) * 100}
            onValueChange={(volume) => voice?.setParticipantVolume(identity, volume / 100)}
            onThumbDblClick={() => voice?.setParticipantVolume(identity, 1)}
          />
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
{:else}
  {@render children()}
{/if}
