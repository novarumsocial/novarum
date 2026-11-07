// Port of apps/frontend/src/lib/components/guild-settings-dialog.svelte, as a scrolling bottom sheet
// Differences: no Roles tab and no Kick/Ban buttons (web stubs stay hidden); the picture comes from the photo library;
// the web's Bots tab is a section here.
import * as ImagePicker from 'expo-image-picker';
import { Camera } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { z } from 'zod';
import { Avatar } from '@/components/avatar';
import { BotBadge } from '@/components/bot-badge';
import { Button } from '@/components/ui/button';
import { AvatarCrop } from '@/components/avatar-crop';
import { Icon } from '@/components/ui/icon';
import { Input, Textarea } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { chat, useChat } from '@/lib/chat-state';
import { addBotToGuild, parseBotHandle, removeBotFromGuild } from '@/lib/bots';
import { cn } from '@/lib/utils';
import type { Server } from '@/lib/types/chat';

const uploadSchema = z.object({ avatarUrl: z.string() });
type Picture = { uri: string; width: number; height: number };

export function GuildSettingsDialog({
  open,
  onClose,
  server,
}: {
  open: boolean;
  onClose: () => void;
  server: Server;
}) {
  const members = useChat((s) => s.members);
  const bots = members.filter((member) => member.isBot);
  const [botHandle, setBotHandle] = useState('');
  const [botRole, setBotRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [botBusy, setBotBusy] = useState(false);
  const [botMessage, setBotMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function addBot() {
    const ref = parseBotHandle(botHandle);
    if (!ref) return setBotMessage({ ok: false, text: 'Use a full handle, like @name:server.' });
    setBotBusy(true);
    const error = await addBotToGuild(server.id, ref, botRole);
    setBotBusy(false);
    setBotMessage(
      error
        ? { ok: false, text: error }
        : { ok: true, text: `Added @${ref.username}:${ref.homeserver}.` }
    );
    if (!error) setBotHandle('');
  }

  async function removeBot(userId: string) {
    setBotBusy(true);
    const error = await removeBotFromGuild(server.id, userId);
    setBotBusy(false);
    setBotMessage(error ? { ok: false, text: error } : null);
  }

  const [crop, setCrop] = useState<Picture | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function selectPicture() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.assets?.[0];
    if (!asset) return;

    setUploadError(null);
    // a GIF is uploaded as is, everything else is cropped to a PNG first
    if (asset.mimeType === 'image/gif') void uploadPicture(asset.uri, 'image/gif');
    else setCrop(asset);
  }

  async function uploadPicture(uri: string, type: 'image/gif' | 'image/png') {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('avatar', {
        uri,
        name: `guild-avatar.${type === 'image/gif' ? 'gif' : 'png'}`,
        type,
      } as unknown as Blob);
      // the phone's cookie store signs the request, like `credentials: 'include'` on the web
      const response = await fetch(`${anchor().baseUrl}/guilds/${server.id}/avatar`, {
        method: 'POST',
        body: form,
      });
      const result = uploadSchema.safeParse(await response.json());
      if (!response.ok || !result.success) throw new Error('upload failed');

      chat().updateGuildAvatar(server.id, result.data.avatarUrl);
    } catch {
      setUploadError('Could not upload the guild picture.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <Sheet open={open} onClose={onClose}>
        <View className="gap-5 px-4 pb-2">
          <View>
            <Text className="text-lg font-semibold">Guild Settings</Text>
            <Text className="text-sm text-muted-foreground">
              Manage how your guild appears to members.
            </Text>
          </View>

          <View className="flex-row items-center gap-4">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change guild picture"
              disabled={uploading}
              onPress={selectPicture}
              className="size-16 items-center justify-center overflow-hidden rounded-full"
            >
              <Avatar src={server.avatarUrl} name={server.name} className="size-16 rounded-full" />
              <View className="absolute inset-0 items-center justify-center bg-black/40">
                {uploading ? <Spinner /> : <Icon as={Camera} size={18} className="text-white" />}
              </View>
            </Pressable>
            <View className="flex-1 gap-1">
              <Text className="text-sm font-medium">Guild Picture</Text>
              <Text className="text-xs text-muted-foreground">
                GIF, JPEG, PNG, or WebP formats are supported!
              </Text>
              {uploadError ? <Text className="text-xs text-destructive">{uploadError}</Text> : null}
            </View>
          </View>

          <View className="gap-1.5">
            <Text className="text-xs font-medium">Guild Name</Text>
            <Input sheet value={server.name} editable={false} />
          </View>

          <View className="gap-1.5">
            <Text className="text-xs font-medium">Description</Text>
            <Textarea
              value={server.description ?? ''}
              editable={false}
              placeholder="Add a description for your guild"
              className="opacity-50"
            />
            <Text className="text-xs text-muted-foreground">
              More guild settings are coming soon!
            </Text>
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium">Bots</Text>
            <Input
              sheet
              value={botHandle}
              onChangeText={(text) => {
                setBotHandle(text);
                setBotMessage(null);
              }}
              placeholder="@weatherbot:novarum.me"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Bot handle"
            />
            <View className="flex-row gap-2">
              {(['MEMBER', 'ADMIN'] as const).map((role) => (
                <Button
                  key={role}
                  size="sm"
                  variant={botRole === role ? 'secondary' : 'outline'}
                  className={cn('flex-1', botRole === role && 'border border-primary/60')}
                  accessibilityState={{ selected: botRole === role }}
                  onPress={() => setBotRole(role)}
                >
                  <Text>{role === 'ADMIN' ? 'Admin' : 'Member'}</Text>
                </Button>
              ))}
              <Button size="sm" disabled={botBusy || !botHandle.trim()} onPress={addBot}>
                <Text>Add</Text>
              </Button>
            </View>
            <Text
              className={cn(
                'text-xs',
                botMessage
                  ? botMessage.ok
                    ? 'text-emerald-500'
                    : 'text-destructive'
                  : 'text-muted-foreground'
              )}
            >
              {botMessage?.text ??
                'Bots can read and send messages in every channel. Only the guild owner can add admin bots.'}
            </Text>
            {bots.map((member) => (
              <View key={member.userId} className="min-h-11 flex-row items-center gap-3">
                <Avatar
                  src={member.avatarUrl}
                  name={member.displayName || member.username}
                  bgColor={member.avatarColor}
                  className="size-8"
                />
                <View className="flex-1">
                  <View className="flex-row items-center gap-1.5">
                    <Text className="shrink text-sm font-medium" numberOfLines={1}>
                      {member.displayName || member.username}
                    </Text>
                    <BotBadge />
                  </View>
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    @{member.username}:{member.server}
                  </Text>
                </View>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={botBusy}
                  onPress={() => void removeBot(member.userId)}
                >
                  <Text className="text-destructive">Remove</Text>
                </Button>
              </View>
            ))}
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium">
              Members <Text className="text-muted-foreground">({members.length})</Text>
            </Text>
            {members.map((member) => (
              <View key={member.userId} className="min-h-11 flex-row items-center gap-3">
                <Avatar
                  src={member.avatarUrl}
                  name={member.displayName || member.username}
                  bgColor={member.avatarColor}
                  className="size-8"
                />
                <View className="flex-1">
                  <Text className="text-sm font-medium" numberOfLines={1}>
                    {member.displayName || member.username}
                  </Text>
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    @{member.username}:{member.server}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </Sheet>
      <AvatarCrop
        image={crop}
        onClose={() => setCrop(null)}
        onCrop={(uri) => {
          setCrop(null);
          void uploadPicture(uri, 'image/png');
        }}
        title="Crop Guild Picture"
        description="Adjust the image to fit your guild icon."
        actionLabel="Use Picture"
      />
    </>
  );
}
