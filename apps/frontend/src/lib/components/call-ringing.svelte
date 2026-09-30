<script lang="ts">
  import { Phone, PhoneOff } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import { Button } from '$lib/components/ui/button/index.js';
  import { chat } from '$lib/chat-state.svelte';
  import { dms, RING_TIMEOUT } from '$lib/dms.svelte';
  import { realtime } from '$lib/realtime.svelte';
  import { notificationSound } from '$lib/notifications';
  import { settings } from '$lib/settings.svelte';
  import { cn } from '$lib/utils';
  import type { Voice } from '$lib/voice.svelte';
  import Avatar from './avatar.svelte';

  let { voice, onAccept }: { voice: Voice; onAccept: (channelId: string) => void } = $props();

  const call = $derived(dms.incomingCall);
  const name = $derived(call ? call.user.displayName || call.user.username : '');
  const callerCount = $derived(call ? (chat.voiceStates[call.channelId]?.length ?? 0) : 0);
  const outgoing = $derived(dms.outgoingCall);
  const outgoingCount = $derived(outgoing ? (chat.voiceStates[outgoing]?.length ?? 0) : 0);
  let callerSeen = false;

  $effect(() => {
    if (call && voice.channelId === call.channelId) dms.incomingCall = null;
  });

  // the ring can arrive before the caller's presence, so only stop once they've been seen and left.
  $effect(() => {
    if (!call) callerSeen = false;
    else if (callerCount) callerSeen = true;
    else if (callerSeen) dms.incomingCall = null;
  });

  // stop ringing out once they pick up or we hang up.
  $effect(() => {
    if (outgoing && (voice.channelId !== outgoing || outgoingCount > 1)) dms.outgoingCall = null;
  });

  $effect(() => {
    if (!call) return;
    notificationSound();
    const ring = setInterval(notificationSound, 2000);
    const timeout = setTimeout(() => (dms.incomingCall = null), RING_TIMEOUT);
    return () => {
      clearInterval(ring);
      clearTimeout(timeout);
    };
  });

  $effect(() => {
    if (!outgoing) return;
    const ring = setInterval(notificationSound, 2000);
    const timeout = setTimeout(() => (dms.outgoingCall = null), RING_TIMEOUT);
    return () => {
      clearInterval(ring);
      clearTimeout(timeout);
    };
  });

  function accept() {
    if (!call) return;
    const { channelId } = call;
    dms.incomingCall = null;
    onAccept(channelId);
  }

  function decline() {
    if (!call) return;
    realtime.ringCall(call.channelId, false);
    dms.incomingCall = null;
  }
</script>

{#if call}
  <div
    transition:fly={{ y: -16, duration: 200 }}
    role="alertdialog"
    aria-label="Incoming call from {name}"
    class={cn(
      'fixed inset-x-4 top-4 z-50 mx-auto flex max-w-sm items-center gap-3 border border-border bg-sidebar/80 p-3 shadow-lg backdrop-blur in-[.desktop]:top-[calc(37px+1rem)]',
      settings.value.circleIcons && 'rounded-xl'
    )}
  >
    <Avatar
      src={call.user.avatarUrl}
      {name}
      bgColor={call.user.avatarColor}
      class="size-10 shrink-0 animate-pulse"
    />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold text-foreground">{name}</p>
      <p class="text-xs text-muted-foreground">Incoming call…</p>
    </div>
    <Button
      variant="destructive"
      size="icon-lg"
      class={cn(settings.value.circleIcons && 'rounded-full')}
      aria-label="Decline"
      onclick={decline}
    >
      <PhoneOff class="size-5" />
    </Button>
    <Button
      size="icon-lg"
      class={cn(
        'bg-green-500/20 text-green-500 hover:bg-green-500/30',
        settings.value.circleIcons && 'rounded-full'
      )}
      aria-label="Accept"
      onclick={accept}
    >
      <Phone class="size-5" />
    </Button>
  </div>
{/if}
