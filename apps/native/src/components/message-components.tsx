// Port of apps/frontend/src/lib/components/message-components.svelte
import { ExternalLink } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import type { ActionRow } from 'anchor/bot-schemas';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Spinner } from './ui/spinner';
import { Text } from './ui/text';
import { interactions, useInteractions } from '@/lib/bots';

const looks = {
  primary: { variant: 'default' },
  secondary: { variant: 'secondary' },
  success: { variant: 'default', className: 'bg-emerald-600' },
  danger: { variant: 'destructive' },
  link: { variant: 'outline' },
} as const;

export function MessageComponents({
  rows,
  channelId,
  messageId,
}: {
  rows: ActionRow[];
  channelId: string;
  messageId: string;
}) {
  const pressing = useInteractions((s) => s.pressing);
  const [error, setError] = useState<string | null>(null);

  return (
    <View className="mt-1.5 gap-1.5">
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} className="flex-row flex-wrap gap-1.5">
          {row.components.map((button, index) => {
            const look = looks[button.style];
            if (button.style === 'link') {
              return (
                <Button
                  key={index}
                  size="sm"
                  variant={look.variant}
                  disabled={button.disabled}
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(button.url)}
                >
                  <Text>{button.label}</Text>
                  <Icon as={ExternalLink} size={12} className="text-foreground" />
                </Button>
              );
            }
            const busy = pressing === `${messageId}:${button.customId}`;
            return (
              <Button
                key={index}
                size="sm"
                variant={look.variant}
                className={'className' in look ? look.className : undefined}
                disabled={button.disabled || !!pressing?.startsWith(`${messageId}:`)}
                accessibilityState={{ busy }}
                onPress={async () =>
                  setError(await interactions().pressButton(channelId, messageId, button.customId))
                }
              >
                {busy && <Spinner />}
                <Text className={button.style === 'success' ? 'text-white' : undefined}>
                  {button.label}
                </Text>
              </Button>
            );
          })}
        </View>
      ))}
      {error && <Text className="text-xs text-destructive">{error}</Text>}
    </View>
  );
}
