// Port of apps/frontend/src/routes/guilds/[...path]: one screen for home, DMs and every guild channel
import { View } from 'react-native';
import { Text } from '@/components/ui/text';

export default function Guilds() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text>Novarum</Text>
    </View>
  );
}
