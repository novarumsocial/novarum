<script lang="ts">
  import type { Command, CommandOption } from 'anchor/bot-schemas';
  import { LoaderCircle, SendHorizontal, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { chat } from '$lib/chat-state.svelte';
  import { interactions, type GuildBotCommands, type OptionValue } from '$lib/bots.svelte';
  import Avatar from './avatar.svelte';

  let {
    entry,
    command,
    channelId,
    onClose,
  }: {
    entry: GuildBotCommands;
    command: Command;
    channelId: string;
    onClose: () => void;
  } = $props();

  // what the person typed, by option name; numbers stay strings until they are sent
  let values = $state<Record<string, string | boolean>>({});
  let sending = $state(false);
  let error = $state<string | null>(null);
  let suggestions = $state<{ option: string; choices: { name: string; value: string | number }[] }>(
    {
      option: '',
      choices: [],
    }
  );
  let autocompleteTimer: ReturnType<typeof setTimeout> | undefined;

  const botName = $derived(entry.bot.displayName || entry.bot.username);
  const options = $derived(command.options ?? []);
  const missing = $derived(
    options.filter((o) => o.required && (values[o.name] === undefined || values[o.name] === ''))
  );

  function toValue(option: CommandOption, raw: string | boolean): OptionValue | undefined {
    if (raw === '' || raw === undefined) return undefined;
    if (option.type === 'boolean') return Boolean(raw);
    if (option.type === 'integer' || option.type === 'number') {
      const number = Number(raw);
      return Number.isFinite(number) ? number : undefined;
    }
    return String(raw);
  }

  function filled(skip?: string) {
    return options.flatMap((option) => {
      const value = option.name === skip ? undefined : toValue(option, values[option.name] ?? '');
      return value === undefined ? [] : [{ name: option.name, value }];
    });
  }

  function askForSuggestions(option: CommandOption) {
    clearTimeout(autocompleteTimer);
    autocompleteTimer = setTimeout(async () => {
      const choices = await interactions.autocomplete(
        channelId,
        entry.bot.userId,
        command.name,
        [...filled(option.name), { name: option.name, value: String(values[option.name] ?? '') }],
        option.name
      );
      suggestions = { option: option.name, choices };
    }, 250);
  }

  async function run(event?: SubmitEvent) {
    event?.preventDefault();
    if (missing.length || sending) return;
    sending = true;
    error = await interactions.runCommand(channelId, entry, command.name, filled());
    sending = false;
    if (!error) onClose();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<form class="flex flex-col gap-2 p-2" onsubmit={run}>
  <div class="flex items-center gap-2">
    <Avatar
      src={entry.bot.avatarUrl}
      name={botName}
      class="size-5 text-[10px]"
      bgColor={entry.bot.avatarColor}
    />
    <span class="text-sm font-semibold">/{command.name}</span>
    <span class="min-w-0 truncate text-xs text-muted-foreground">{command.description}</span>
    <Button
      variant="ghost"
      size="icon-xs"
      class="ml-auto"
      aria-label="Close command"
      onclick={onClose}
    >
      <X class="size-3" />
    </Button>
  </div>

  {#if options.length}
    <div class="grid gap-2 sm:grid-cols-2">
      {#each options as option, index (option.name)}
        <label class="flex min-w-0 flex-col gap-1">
          <span class="text-xs font-medium">
            {option.name}{#if option.required}<span class="text-destructive" aria-hidden="true"
                >*</span
              >{/if}
            <span class="font-normal text-muted-foreground">{option.description}</span>
          </span>

          {#if option.type === 'boolean'}
            <Switch
              checked={values[option.name] === true}
              onCheckedChange={(checked) => (values[option.name] = checked)}
              aria-label={option.name}
            />
          {:else if option.type === 'user'}
            <Select.Root
              type="single"
              value={String(values[option.name] ?? '')}
              onValueChange={(value) => (values[option.name] = value)}
            >
              <Select.Trigger class="w-full">
                {chat.members.find((m) => m.userId === values[option.name])?.displayName ||
                  chat.members.find((m) => m.userId === values[option.name])?.username ||
                  'Pick a member'}
              </Select.Trigger>
              <Select.Content>
                {#each chat.members as member (member.userId)}
                  <Select.Item value={member.userId}
                    >{member.displayName || member.username}</Select.Item
                  >
                {/each}
              </Select.Content>
            </Select.Root>
          {:else if option.choices?.length}
            <Select.Root
              type="single"
              value={String(values[option.name] ?? '')}
              onValueChange={(value) => (values[option.name] = value)}
            >
              <Select.Trigger class="w-full">
                {option.choices.find((c) => String(c.value) === values[option.name])?.name ??
                  'Choose one'}
              </Select.Trigger>
              <Select.Content>
                {#each option.choices as choice (choice.value)}
                  <Select.Item value={String(choice.value)}>{choice.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          {:else}
            <Input
              type={option.type === 'string' ? 'text' : 'number'}
              step={option.type === 'integer' ? 1 : 'any'}
              min={option.minValue}
              max={option.maxValue}
              minlength={option.minLength}
              maxlength={option.maxLength}
              autocomplete="off"
              value={String(values[option.name] ?? '')}
              oninput={(event) => {
                values[option.name] = event.currentTarget.value;
                if (option.autocomplete) askForSuggestions(option);
              }}
              onfocus={() => option.autocomplete && askForSuggestions(option)}
              {@attach (input) => {
                if (index === 0) input.focus();
              }}
            />
            {#if suggestions.option === option.name && suggestions.choices.length}
              <div
                role="listbox"
                class="max-h-40 overflow-y-auto border border-border bg-popover p-1"
              >
                {#each suggestions.choices as choice (choice.value)}
                  <button
                    type="button"
                    role="option"
                    aria-selected={values[option.name] === String(choice.value)}
                    class="block w-full truncate px-2 py-1.5 text-left text-xs hover:bg-muted"
                    onmousedown={(event) => event.preventDefault()}
                    onclick={() => {
                      values[option.name] = String(choice.value);
                      suggestions = { option: '', choices: [] };
                    }}
                  >
                    {choice.name}
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </label>
      {/each}
    </div>
  {/if}

  {#if error}
    <p class="text-xs text-destructive" role="alert">{error}</p>
  {/if}

  <div class="flex items-center justify-end gap-2">
    {#if missing.length}
      <span class="text-xs text-muted-foreground"
        >Fill in {missing.map((o) => o.name).join(', ')}</span
      >
    {/if}
    <Button type="submit" size="sm" disabled={!!missing.length || sending}>
      {#if sending}<LoaderCircle class="size-3.5 animate-spin" />{:else}<SendHorizontal
          class="size-3.5"
        />{/if}
      Use /{command.name}
    </Button>
  </div>
</form>
