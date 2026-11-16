// Port of apps/frontend/src/lib/components/group-settings-dialog.svelte
// Only the group's owner opens this; the server checks it again anyway.
import * as ImagePicker from 'expo-image-picker';
import { Camera, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { AvatarCrop } from '@/components/avatar-crop';
import { BotBadge } from '@/components/bot-badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { parseBotHandle } from '@/lib/bots';
import { dmDisplay, dms, type DmEntry } from '@/lib/dms';
import { cn } from '@/lib/utils';

type Picture = { uri: string; width: number; height: number };

export function GroupSettingsDialog({
  open,
  onClose,
  group,
}: {
  open: boolean;
  onClose: () => void;
  group: DmEntry;
}) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [botHandle, setBotHandle] = useState('');
  const [crop, setCrop] = useState<Picture | null>(null);
  const bots = group.participants.filter((user) => user.isBot);

  useEffect(() => {
    if (!open) return;
    setName(group.name ?? '');
    setMessage(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(action: () => Promise<string | null>, done: string) {
    setBusy(true);
    const error = await action();
    setBusy(false);
    setMessage(error ? { ok: false, text: error } : { ok: true, text: done });
    return !error;
  }

  async function addBot() {
    const ref = parseBotHandle(botHandle);
    if (!ref) return setMessage({ ok: false, text: 'Use a full handle, like @name:server.' });
    if (await run(() => dms().addBot(group.id, ref), `Added @${ref.username}:${ref.homeserver}.`))
      setBotHandle('');
  }

  async function selectPicture() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.assets?.[0];
    if (!asset) return;
    // a GIF is uploaded as is, everything else is cropped to a PNG first
    if (asset.mimeType === 'image/gif')
      void run(() => dms().uploadIcon(group.id, asset.uri, 'image/gif'), 'Icon updated.');
    else setCrop(asset);
  }

  return (
    <>
      <Sheet open={open} onClose={onClose}>
        <View className="gap-5 px-4 pb-2">
          <View>
            <Text className="text-lg font-semibold">Group Settings</Text>
            <Text className="text-sm text-muted-foreground">
              Everyone in the group sees these changes.
            </Text>
          </View>

          <View className="flex-row items-end gap-4">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change group icon"
              disabled={busy}
              onPress={selectPicture}
              className="size-16 items-center justify-center overflow-hidden rounded-full"
            >
              <Avatar
                src={group.iconUrl}
                name={dmDisplay(group).name}
                className="size-16 rounded-full"
              />
              <View className="absolute inset-0 items-center justify-center bg-black/40">
                {busy ? <Spinner /> : <Icon as={Camera} size={18} className="text-white" />}
              </View>
            </Pressable>
            <View className="flex-1 gap-1.5">
              <Text className="text-xs font-medium">Group Name</Text>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Input
                    sheet
                    value={name}
                    onChangeText={setName}
                    maxLength={100}
                    placeholder="Members' names"
                    accessibilityLabel="Group name"
                  />
                </View>
                <Button
                  disabled={busy || name.trim() === (group.name ?? '')}
                  onPress={() => void run(() => dms().rename(group.id, name.trim()), 'Saved.')}
                >
                  <Text>Save</Text>
                </Button>
              </View>
            </View>
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium">Bots</Text>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Input
                  sheet
                  value={botHandle}
                  onChangeText={(text) => {
                    setBotHandle(text);
                    setMessage(null);
                  }}
                  placeholder="@bot:homeserver"
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Bot handle"
                />
              </View>
              <Button disabled={busy || !botHandle.trim()} onPress={() => void addBot()}>
                <Text>Add</Text>
              </Button>
            </View>
            {bots.map((bot) => (
              <View key={bot.userId} className="min-h-11 flex-row items-center gap-2">
                <Avatar
                  src={bot.avatarUrl}
                  name={bot.displayName || bot.username}
                  bgColor={bot.avatarColor}
                  className="size-8"
                />
                <Text numberOfLines={1} className="shrink text-sm">
                  {bot.displayName || bot.username}
                </Text>
                <BotBadge />
                <View className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon"
                  accessibilityLabel={`Remove ${bot.username}`}
                  disabled={busy}
                  onPress={() => void run(() => dms().kick(group.id, bot.userId), 'Bot removed.')}
                >
                  <Icon as={Trash2} size={16} />
                </Button>
              </View>
            ))}
          </View>

          {message && (
            <Text
              className={cn('text-xs', message.ok ? 'text-muted-foreground' : 'text-destructive')}
            >
              {message.text}
            </Text>
          )}
        </View>
      </Sheet>
      <AvatarCrop
        image={crop}
        onClose={() => setCrop(null)}
        onCrop={(uri) => {
          setCrop(null);
          void run(() => dms().uploadIcon(group.id, uri, 'image/png'), 'Icon updated.');
        }}
        title="Crop Group Icon"
        description="Adjust the image to fit the group icon."
        actionLabel="Use Icon"
      />
    </>
  );
}
