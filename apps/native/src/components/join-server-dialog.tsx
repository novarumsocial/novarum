// Native-only: "Join a server" from the rail's add button. Takes an invite link (or a bare `code@homeserver`)
// and opens the invite screen, which shows the server and joins it.
import { router, type Href } from 'expo-router';
import { ArrowRight } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

// "https://app.novarum.me/i/abc@example.org", "/i/abc@example.org" or "abc@example.org"
export const inviteFromText = (text: string) => {
  const value = text.trim().split(/\/i\//).at(-1)?.split(/[?#]/)[0]?.replace(/\/+$/, '') ?? '';
  return /^\$?[\w-]+@[\w.-]+(:\d+)?$/.test(value) ? value : null;
};

export function JoinServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setText('');
      setError('');
    }
  }, [open]);

  function submit() {
    const invite = inviteFromText(text);
    if (!invite) {
      setError('Paste an invite link, like https://app.novarum.me/i/code@server.');
      return;
    }
    onClose();
    router.push(`/i/${encodeURIComponent(invite)}` as Href);
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Join a server"
      subtitle="Paste an invite link someone sent you."
    >
      <View className="gap-3 px-4 pt-3 pb-2">
        <Input
          sheet
          value={text}
          onChangeText={(value) => {
            setText(value);
            setError('');
          }}
          placeholder="https://app.novarum.me/i/…"
          accessibilityLabel="Invite link"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        {error ? (
          <Text className="text-sm text-destructive" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <Button disabled={!text.trim()} onPress={submit}>
          <Text>Continue</Text>
          <Icon as={ArrowRight} className="text-primary-foreground" />
        </Button>
      </View>
    </Sheet>
  );
}
