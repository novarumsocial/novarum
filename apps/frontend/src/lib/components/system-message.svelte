<script lang="ts">
  import {
    Crown,
    Image,
    LogOut,
    Pencil,
    Phone,
    PhoneMissed,
    UserMinus,
    UserPlus,
    Users,
  } from '@lucide/svelte';
  import { systemText } from '$lib/system-message';
  import type { Message } from '$lib/types/chat';

  let { message }: { message: Message & { system: NonNullable<Message['system']> } } = $props();

  const icons = {
    'group.created': Users,
    'member.added': UserPlus,
    'bot.added': UserPlus,
    'member.removed': UserMinus,
    'bot.removed': UserMinus,
    'member.left': LogOut,
    'owner.changed': Crown,
    'group.renamed': Pencil,
    'group.icon': Image,
    call: Phone,
  };
  const missed = $derived(message.system.type === 'call' && message.system.missed);
  const Icon = $derived(missed ? PhoneMissed : icons[message.system.type]);
</script>

<div
  class="-mx-3 flex items-center gap-3 px-3 py-1 text-sm text-muted-foreground sm:-mx-4 sm:px-4"
  role="note"
>
  <span class="flex w-9 shrink-0 justify-center">
    <Icon
      class="size-4 {missed
        ? 'text-destructive'
        : message.system.type === 'call'
          ? 'text-green-500'
          : ''}"
    />
  </span>
  <span class="min-w-0 flex-1">
    {systemText(message.system, message.author)}
    <time
      class="ml-1 text-[10px] text-muted-foreground/60"
      datetime={message.timestamp.toISOString()}
    >
      {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  </span>
</div>
