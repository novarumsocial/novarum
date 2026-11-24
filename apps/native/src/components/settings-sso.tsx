// Port of apps/frontend/src/lib/components/settings-sso.svelte
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useAnchor } from '@/lib/anchor';
import { getErrorMessage } from '@/lib/session';
import { startSignOn } from '@/lib/sso';
import { SettingsGroup } from './settings-group';
import { SettingsRow } from './settings-row';

type Identities = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof useAnchor.getState>['client']['auth']['sso']['identities']['get']>
  >['data']
>;

export function SettingsSso({ onPasswordless }: { onPasswordless?: (value: boolean) => void }) {
  const { client, auth, homeServer } = useAnchor();
  const [linked, setLinked] = useState<Identities | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error: loadError } = await client.auth.sso.identities.get();
    if (loadError) return setError(getErrorMessage(loadError.value, 'Could not load.'));
    setLinked(data);
    onPasswordless?.(!data.hasPassword);
  }, [client, onPasswordless]);

  // linking comes back through the sso screen, so reload whenever this screen is shown again
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  // configured providers first, then ones linked before the server dropped them
  const rows = [
    ...auth.providers,
    ...(linked?.identities ?? [])
      .filter((identity) => !auth.providers.some((p) => p.id === identity.provider))
      .map((identity) => ({ id: identity.provider, name: identity.name })),
  ];
  if (!rows.length || !linked) return null;

  const link = async (provider: string) => {
    setBusy(provider);
    setError((await startSignOn(provider, { link: true })) ?? '');
    setBusy(null);
  };

  const unlink = async (provider: string) => {
    setBusy(provider);
    setError('');
    const { error: unlinkError } = await client.auth.sso.identities({ provider }).delete();
    if (unlinkError) setError(getErrorMessage(unlinkError.value, 'Could not unlink.'));
    setBusy(null);
    await load();
  };

  return (
    <SettingsGroup
      title="Single sign-on"
      description={`Accounts you can sign in to ${homeServer} with.`}
    >
      {rows.map((provider) => {
        const identity = linked.identities.find((i) => i.provider === provider.id);
        return (
          <SettingsRow
            key={provider.id}
            title={provider.name}
            description={
              identity ? `Linked${identity.email ? ` as ${identity.email}` : ''}` : undefined
            }
          >
            {identity ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onPress={() => unlink(provider.id)}
              >
                <Text>Unlink</Text>
              </Button>
            ) : (
              <Button size="sm" disabled={busy !== null} onPress={() => link(provider.id)}>
                <Text>Link</Text>
              </Button>
            )}
          </SettingsRow>
        );
      })}
      {error ? <Text className="px-4 py-3 text-xs text-destructive">{error}</Text> : null}
    </SettingsGroup>
  );
}
