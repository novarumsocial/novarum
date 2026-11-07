// Port of apps/frontend/src/lib/components/command-form.svelte
// Choices and members are picked from a sheet, the phone's version of the web's selects.
import { ChevronDown, SendHorizontal, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { Command, CommandOption } from 'anchor/bot-schemas';
import { Avatar } from './avatar';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Sheet } from './ui/sheet';
import { SheetItem } from './ui/sheet-item';
import { Spinner } from './ui/spinner';
import { Switch } from './ui/switch';
import { Text } from './ui/text';
import { interactions, type GuildBotCommands, type OptionValue } from '@/lib/bots';
import { useChat } from '@/lib/chat-state';

type Choice = { name: string; value: string | number };

function toValue(
  option: CommandOption,
  raw: string | boolean | undefined
): OptionValue | undefined {
  if (raw === '' || raw === undefined) return undefined;
  if (option.type === 'boolean') return Boolean(raw);
  if (option.type === 'integer' || option.type === 'number') {
    const number = Number(raw);
    return Number.isFinite(number) ? number : undefined;
  }
  return String(raw);
}

export function CommandForm({
  entry,
  command,
  channelId,
  onClose,
}: {
  entry: GuildBotCommands;
  command: Command;
  channelId: string;
  onClose: () => void;
}) {
  // what the person typed, by option name; numbers stay strings until they are sent
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ option: string; choices: Choice[] }>({
    option: '',
    choices: [],
  });
  const [picking, setPicking] = useState<CommandOption | null>(null);
  const autocompleteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const members = useChat((s) => s.members);

  const botName = entry.bot.displayName || entry.bot.username;
  const options = command.options ?? [];
  const missing = options.filter(
    (o) => o.required && (values[o.name] === undefined || values[o.name] === '')
  );
  const set = (name: string, value: string | boolean) =>
    setValues((v) => ({ ...v, [name]: value }));

  useEffect(() => () => clearTimeout(autocompleteTimer.current), []);

  const filled = (skip?: string) =>
    options.flatMap((option) => {
      const value = option.name === skip ? undefined : toValue(option, values[option.name]);
      return value === undefined ? [] : [{ name: option.name, value }];
    });

  function askForSuggestions(option: CommandOption, typed: string) {
    clearTimeout(autocompleteTimer.current);
    autocompleteTimer.current = setTimeout(async () => {
      const choices = await interactions().autocomplete(
        channelId,
        entry.bot.userId,
        command.name,
        [...filled(option.name), { name: option.name, value: typed }],
        option.name
      );
      setSuggestions({ option: option.name, choices });
    }, 250);
  }

  async function run() {
    if (missing.length || sending) return;
    setSending(true);
    const failed = await interactions().runCommand(channelId, entry, command.name, filled());
    setSending(false);
    setError(failed);
    if (!failed) onClose();
  }

  const label = (option: CommandOption) => {
    const value = values[option.name];
    if (option.type === 'user') {
      const member = members.find((m) => m.userId === value);
      return member ? member.displayName || member.username : 'Pick a member';
    }
    return option.choices?.find((c) => String(c.value) === value)?.name ?? 'Choose one';
  };

  return (
    <View className="gap-2 p-2">
      <View className="flex-row items-center gap-2">
        <Avatar
          src={entry.bot.avatarUrl}
          name={botName}
          bgColor={entry.bot.avatarColor}
          className="size-5"
        />
        <Text className="text-sm font-semibold">/{command.name}</Text>
        <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
          {command.description}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close command"
          hitSlop={10}
          onPress={onClose}
          className="ml-auto size-7 items-center justify-center"
        >
          <Icon as={X} size={14} className="text-muted-foreground" />
        </Pressable>
      </View>

      {options.map((option, index) => (
        <View key={option.name} className="gap-1">
          <Text className="text-xs font-medium">
            {option.name}
            {option.required && <Text className="text-xs text-destructive">*</Text>}
            <Text className="text-xs text-muted-foreground"> {option.description}</Text>
          </Text>

          {option.type === 'boolean' ? (
            <Switch
              value={values[option.name] === true}
              onValueChange={(checked) => set(option.name, checked)}
              accessibilityLabel={option.name}
            />
          ) : option.type === 'user' || option.choices?.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setPicking(option)}
              className="min-h-11 flex-row items-center justify-between border border-input bg-background px-3 active:bg-accent"
            >
              <Text className="text-[15px]">{label(option)}</Text>
              <Icon as={ChevronDown} size={16} className="text-muted-foreground" />
            </Pressable>
          ) : (
            <Input
              autoFocus={index === 0}
              keyboardType={option.type === 'string' ? 'default' : 'numeric'}
              maxLength={option.maxLength}
              autoCorrect={false}
              value={String(values[option.name] ?? '')}
              onChangeText={(text) => {
                set(option.name, text);
                if (option.autocomplete) askForSuggestions(option, text);
              }}
              onFocus={() =>
                option.autocomplete && askForSuggestions(option, String(values[option.name] ?? ''))
              }
              className="text-[15px]"
            />
          )}

          {suggestions.option === option.name && suggestions.choices.length > 0 && (
            <ScrollView
              keyboardShouldPersistTaps="always"
              className="max-h-40 border border-border bg-popover"
            >
              {suggestions.choices.map((choice) => (
                <Pressable
                  key={String(choice.value)}
                  accessibilityRole="button"
                  onPress={() => {
                    set(option.name, String(choice.value));
                    setSuggestions({ option: '', choices: [] });
                  }}
                  className="min-h-10 justify-center px-3 active:bg-accent"
                >
                  <Text className="text-sm">{choice.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      ))}

      {error && <Text className="text-xs text-destructive">{error}</Text>}

      <View className="flex-row items-center justify-end gap-2">
        {missing.length > 0 && (
          <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
            Fill in {missing.map((o) => o.name).join(', ')}
          </Text>
        )}
        <Button size="sm" disabled={!!missing.length || sending} onPress={run}>
          {sending ? (
            <Spinner />
          ) : (
            <Icon as={SendHorizontal} size={14} className="text-primary-foreground" />
          )}
          <Text>Use /{command.name}</Text>
        </Button>
      </View>

      {picking && (
        <Sheet open onClose={() => setPicking(null)}>
          {(picking.type === 'user'
            ? members.map((m) => ({ name: m.displayName || m.username, value: m.userId }))
            : (picking.choices ?? [])
          ).map((choice) => (
            <SheetItem
              key={String(choice.value)}
              label={choice.name}
              onPress={() => {
                set(picking.name, String(choice.value));
                setPicking(null);
              }}
            />
          ))}
        </Sheet>
      )}
    </View>
  );
}
