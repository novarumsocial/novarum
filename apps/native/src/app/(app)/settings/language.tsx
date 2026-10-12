// Port of the "langt" tab of apps/frontend/src/lib/components/settings-dialog.svelte
import { Pressable, View } from 'react-native';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { Text } from '@/components/ui/text';
import { useSettings, type TimeFormat } from '@/lib/settings';
import { cn } from '@/lib/utils';

// localization should be properly implemented at some point (the language is only stored, like on the web)
const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'la', label: 'Latin' },
];

const timeFormats: { value: TimeFormat; label: string; example: string }[] = [
  { value: 'auto', label: 'Automatic', example: 'Follow your system settings' },
  { value: '12hr', label: '12-hour', example: 'Example: 3:30 PM' },
  { value: '24hr', label: '24-hour', example: 'Example: 15:30' },
];

function RadioRow({
  label,
  description,
  selected,
  onPress,
}: {
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      className="flex-row items-center justify-between gap-4 px-4 py-3 active:bg-accent"
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium">{label}</Text>
        {description ? (
          <Text className="mt-0.5 text-xs text-muted-foreground">{description}</Text>
        ) : null}
      </View>
      <View
        className={cn(
          'size-5 items-center justify-center rounded-full border',
          selected ? 'border-primary' : 'border-input'
        )}
      >
        {selected && <View className="size-2.5 rounded-full bg-primary" />}
      </View>
    </Pressable>
  );
}

export default function Language() {
  const language = useSettings((s) => s.language);
  const timeFormat = useSettings((s) => s.timeFormat);
  const update = useSettings((s) => s.update);

  return (
    <SettingsPage description="Set your language and how times are shown.">
      <SettingsGroup title="Language">
        {languageOptions.map((option) => (
          <RadioRow
            key={option.value}
            label={option.label}
            selected={language === option.value}
            onPress={() => update({ language: option.value })}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Time format">
        {timeFormats.map((format) => (
          <RadioRow
            key={format.value}
            label={format.label}
            description={format.example}
            selected={timeFormat === format.value}
            onPress={() => update({ timeFormat: format.value })}
          />
        ))}
      </SettingsGroup>
    </SettingsPage>
  );
}
