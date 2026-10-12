// Port of apps/frontend/src/lib/components/settings-group.svelte (plus `SettingsPage`, the scrolling frame every settings screen shares)
import { Children, type ReactNode } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Separator } from './ui/separator';
import { Text } from './ui/text';

export function SettingsGroup({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  const rows = Children.toArray(children);
  return (
    <View className="gap-2.5">
      {title ? (
        <View>
          <Text className="text-sm font-medium">{title}</Text>
          {description ? (
            <Text className="text-xs text-muted-foreground">{description}</Text>
          ) : null}
        </View>
      ) : null}
      <View className="bg-card">
        {rows.map((row, i) => (
          <View key={i}>
            {i > 0 && <Separator className="bg-border/60" />}
            {row}
          </View>
        ))}
      </View>
    </View>
  );
}

// the web's `head` snippet is the screen header here, so only the description stays in the page
export function SettingsPage({
  description,
  children,
}: {
  description?: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAwareScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
      contentContainerStyle={{ gap: 24, padding: 16, paddingBottom: insets.bottom + 32 }}
    >
      {description ? <Text className="text-sm text-muted-foreground">{description}</Text> : null}
      {children}
    </KeyboardAwareScrollView>
  );
}
