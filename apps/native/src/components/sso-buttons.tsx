// Port of apps/frontend/src/lib/components/sso-buttons.svelte
import { KeyRound } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import type { AnchorAuthInfo } from '@/lib/api';
import { startSignOn } from '@/lib/sso';

export function SsoButtons({
  homeServer,
  providers,
  redirect,
}: {
  homeServer: string;
  providers: AnchorAuthInfo['providers'];
  redirect?: string;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (!providers.length) return null;

  const signOn = async (provider: string) => {
    setPending(provider);
    setError('');
    try {
      await anchor().setHomeServer(homeServer);
      setError((await startSignOn(provider, { redirect })) ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach that server.');
    }
    setPending(null);
  };

  return (
    <View className="gap-2">
      <View className="my-3 flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-xs text-muted-foreground">or</Text>
        <View className="h-px flex-1 bg-border" />
      </View>
      {providers.map((provider) => (
        <Button
          key={provider.id}
          variant="outline"
          size="lg"
          className="w-full"
          disabled={pending !== null}
          onPress={() => signOn(provider.id)}
        >
          {pending === provider.id ? <Spinner /> : <Icon as={KeyRound} size={16} />}
          <Text>Continue with {provider.name}</Text>
        </Button>
      ))}
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
    </View>
  );
}
