<script lang="ts">
  import { Command as CommandPrimitive } from 'bits-ui';
  import * as InputGroup from '$lib/components/ui/input-group/index.js';
  import SearchIcon from '@lucide/svelte/icons/search';
  import type { EmojiPickerSearchProps } from './types';
  import { useEmojiPickerInput } from './emoji-picker.svelte.js';
  import { box } from 'svelte-toolbelt';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    value = $bindable(''),
    placeholder = 'Search',
    class: className,
    ...rest
  }: EmojiPickerSearchProps = $props();

  useEmojiPickerInput({
    value: box.with(
      () => value,
      (v) => (value = v)
    )
  });
</script>

<div data-slot="emoji-picker-input-wrapper" class="border-b p-2 pb-0">
  <InputGroup.Root
    class="h-8 border-none border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!"
  >
    <CommandPrimitive.Input
      {...rest}
      {placeholder}
      data-slot="emoji-picker-input"
      class={cn(
        'w-full text-xs outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      bind:value
    >
      {#snippet child({ props })}
        <InputGroup.Input {...props} bind:value bind:ref />
      {/snippet}
    </CommandPrimitive.Input>
    <InputGroup.Addon>
      <SearchIcon class="size-4 shrink-0 opacity-50" />
    </InputGroup.Addon>
  </InputGroup.Root>
</div>
