// Port of apps/frontend/src/lib/components/moderation-dialog.svelte
import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { moderation, useModeration } from '@/lib/moderation';

export function ModerationSheet() {
  const pending = useModeration((s) => s.pending);
  const busy = useModeration((s) => s.busy);
  const error = useModeration((s) => s.error);
  const [reason, setReason] = useState('');

  const who =
    pending && pending.kind !== 'leave'
      ? pending.member.displayName || pending.member.username
      : '';
  const copy = !pending
    ? { title: '', description: '', action: '' }
    : pending.kind === 'leave'
      ? {
          title: `Leave ${pending.server.name}?`,
          description: "You'll need a new invite to join again.",
          action: 'Leave server',
        }
      : pending.kind === 'kick'
        ? {
            title: `Kick ${who}?`,
            description: `${who} will be removed from ${pending.server.name}. They can join again with an invite.`,
            action: 'Kick',
          }
        : {
            title: `Ban ${who}?`,
            description: `${who} will be removed from ${pending.server.name} and can't join again until the ban is lifted.`,
            action: 'Ban',
          };

  const close = () => {
    moderation().cancel();
    setReason('');
  };

  return (
    <Sheet open={!!pending} onClose={close} title={copy.title} subtitle={copy.description}>
      <View className="gap-3 px-4 pt-3 pb-2">
        {pending?.kind === 'ban' && (
          <Input
            sheet
            value={reason}
            onChangeText={setReason}
            maxLength={512}
            placeholder="Reason (optional)"
            accessibilityLabel="Ban reason"
          />
        )}
        {error ? (
          <Text className="text-sm text-destructive" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <Button
          variant="destructive"
          disabled={busy}
          onPress={async () => {
            await moderation().confirm(reason.trim());
            if (!moderation().pending) setReason('');
          }}
        >
          <Text>{copy.action}</Text>
        </Button>
        <Button variant="outline" onPress={close}>
          <Text>Cancel</Text>
        </Button>
      </View>
    </Sheet>
  );
}
