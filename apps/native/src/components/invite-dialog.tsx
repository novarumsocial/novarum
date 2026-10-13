// Port of apps/frontend/src/lib/components/invite-dialog.svelte, as a bottom sheet with the native share sheet
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Check, Copy, RefreshCw, Share2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useAnchor } from '@/lib/anchor';
import { chat } from '@/lib/chat-state';

const inviteSchema = z.object({ invite: z.object({ code: z.string() }) });

export function InviteDialog({
  open,
  onClose,
  guildId,
}: {
  open: boolean;
  onClose: () => void;
  guildId: string;
}) {
  const homeServer = useAnchor((s) => s.homeServer);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  const inviteUrl = `https://app.novarum.me/i/${code}@${homeServer}`;

  async function createInvite() {
    setLoading(true);
    const invite = inviteSchema.safeParse(await chat().createGuildInvite(guildId));
    if (invite.success) setCode(invite.data.invite.code);
    setLoading(false);
  }

  async function fetchInvite() {
    setLoading(true);
    const invite = inviteSchema.safeParse(await chat().getGuildInvite(guildId));
    if (invite.success) {
      setCode(invite.data.invite.code);
      setLoading(false);
    } else await createInvite();
  }

  useEffect(() => {
    if (open && !code) void fetchInvite();
    if (!open) {
      setCopied(false);
      setCode('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function copyInvite() {
    await Clipboard.setStringAsync(inviteUrl);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <View className="gap-4 px-4 pb-2">
        <View>
          <Text className="text-lg font-semibold">Invite People</Text>
          <Text className="text-sm text-muted-foreground">
            Share this link to let people join the server. It's active indefinitely until
            regenerated.
          </Text>
        </View>
        <View className="gap-1.5">
          <Text className="text-xs font-medium">Invite Link</Text>
          <View className="flex-row gap-2">
            <Input
              sheet
              value={code ? inviteUrl : ''}
              editable={false}
              className="flex-1 font-mono text-xs"
            />
            <Button
              variant="outline"
              size="icon"
              accessibilityLabel="Copy invite link"
              onPress={copyInvite}
              disabled={loading || !code}
            >
              {loading ? <Spinner /> : <Icon as={copied ? Check : Copy} size={18} />}
            </Button>
          </View>
        </View>
        <View className="flex-row gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            className="mr-auto"
            disabled={loading}
            onPress={() => {
              setCopied(false);
              void createInvite();
            }}
          >
            <Icon as={RefreshCw} />
            <Text>Regenerate</Text>
          </Button>
          <Button
            disabled={loading || !code}
            // iOS shares a url and a message as two items, so it gets only the url
            onPress={() =>
              void Share.share(Platform.OS === 'ios' ? { url: inviteUrl } : { message: inviteUrl })
            }
          >
            <Icon as={Share2} className="text-primary-foreground" />
            <Text>Share</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
