// Native-only (the web/Capacitor app has no update channels): see which OTA bundle is running, and
// test a PR by switching to the channel CI deploys its branch to
import { useState } from 'react';
import { View } from 'react-native';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { branchChannel, checkForUpdates, hotUpdater, resetChannel } from '@/lib/ota';
import { toast } from '@/lib/toast';

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-4 px-4 py-3">
      <Text className="text-sm">{label}</Text>
      <Text className="shrink font-mono text-xs text-muted-foreground" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function Updates() {
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState<'check' | 'switch' | 'reset' | null>(null);
  const channel = hotUpdater.getChannel();
  const switched = hotUpdater.isChannelSwitched();

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<unknown>) {
    setBusy(kind);
    try {
      // a successful update reloads the app, so reaching the end means there was nothing to apply
      if (!(await action()) && kind !== 'reset') toast('No update available for this build');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Update failed', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsPage description="Updates download in the background when the app starts.">
      <SettingsGroup title="Running">
        <InfoRow label="Channel" value={channel} />
        <InfoRow label="Bundle" value={hotUpdater.getBundleId()} />
        <InfoRow label="Native build" value={hotUpdater.getFingerprintHash()?.slice(0, 12) ?? '-'} />
      </SettingsGroup>
      <Button
        variant="outline"
        className="self-start"
        disabled={busy !== null}
        onPress={() => run('check', () => checkForUpdates())}
      >
        {busy === 'check' && <Spinner />}
        <Text>Check for updates</Text>
      </Button>

      <SettingsGroup
        title="Test a branch"
        description="Every pull request is published to a channel named after its branch. Only branches without native changes can run on this build."
      >
        <View className="gap-3 p-4">
          <Input
            value={branch}
            onChangeText={setBranch}
            placeholder="feat/my-branch"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => branch && run('switch', () => checkForUpdates(branchChannel(branch)))}
          />
          <Button
            disabled={!branchChannel(branch) || busy !== null}
            onPress={() => run('switch', () => checkForUpdates(branchChannel(branch)))}
          >
            {busy === 'switch' && <Spinner />}
            <Text>Switch to branch</Text>
          </Button>
          {switched && (
            <Button
              variant="outline"
              disabled={busy !== null}
              onPress={() => run('reset', resetChannel)}
            >
              {busy === 'reset' && <Spinner />}
              <Text>Back to {hotUpdater.getDefaultChannel()}</Text>
            </Button>
          )}
        </View>
      </SettingsGroup>
    </SettingsPage>
  );
}
