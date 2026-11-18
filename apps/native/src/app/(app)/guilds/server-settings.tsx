// A server's settings, pushed over the channel list (the web's guild settings dialog)
import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { GuildSettings } from '@/components/guild-settings';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useChat } from '@/lib/chat-state';

export default function ServerSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const server = useChat((s) => s.servers.find((item) => item.id === id));

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader>
        <Text role="heading" numberOfLines={1} className="text-base font-semibold">
          {server ? `${server.name} settings` : 'Server settings'}
        </Text>
      </ScreenHeader>
      {server ? (
        <GuildSettings server={server} />
      ) : (
        <Text className="p-6 text-center text-sm text-muted-foreground">
          This server is no longer available.
        </Text>
      )}
    </View>
  );
}
