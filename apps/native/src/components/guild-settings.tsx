// Port of apps/frontend/src/lib/components/guild-settings-dialog.svelte, as its own screen (guilds/server-settings)
// Differences: no Roles tab and no Kick/Ban buttons (web stubs stay hidden); the picture comes from the photo library;
// the web's Bots tab is a section here. Name and description can't be changed yet, so they show as plain text, and
// the member list lives on the Members screen only.
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
import { Input } from '@/components/ui/input';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { SettingsRow } from '@/components/settings-row';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { chat, useChat } from '@/lib/chat-state';
import { addBotToGuild, parseBotHandle, removeBotFromGuild } from '@/lib/bots';
import { useSettings } from '@/lib/settings';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { Server } from '@/lib/types/chat';

const uploadSchema = z.object({ avatarUrl: z.string() });
type Picture = { uri: string; width: number; height: number };

export function GuildSettings({ server }: { server: Server }) {
  const circleIcons = useSettings((s) => s.circleIcons);
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

  async function selectPicture() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.assets?.[0];
    if (!asset) return;

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
      toast('Server picture updated');
    } catch {
      toast('Could not upload the server picture.', { tone: 'error' });
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <SettingsPage>
        <View className="flex-row items-center gap-4 px-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change server picture"
            disabled={uploading}
            onPress={selectPicture}
            className={cn(
              'size-20 items-center justify-center overflow-hidden',
              circleIcons && 'rounded-full'
            )}
          >
            <Avatar src={server.avatarUrl} name={server.name} className="size-20" />
            <View className="absolute inset-0 items-center justify-center bg-black/40">
              {uploading ? <Spinner /> : <Icon as={Camera} size={22} className="text-white" />}
            </View>
          </Pressable>
          <View className="flex-1 gap-1">
            <Text className="text-base font-medium">Server picture</Text>
            <Text className="text-sm text-muted-foreground">
              Tap to change it. GIF, JPEG, PNG or WebP.
            </Text>
          </View>
        </View>

        <SettingsGroup title="About">
          <SettingsRow title="Name" stacked>
            <Text selectable className="text-base">
              {server.name}
            </Text>
          </SettingsRow>
          <SettingsRow title="Description" stacked>
            <Text
              selectable
              className={cn('text-base', !server.description && 'text-muted-foreground')}
            >
              {server.description || 'No description'}
            </Text>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Bots">
          <View className="gap-2 p-4">
            <Input
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
                  variant={botRole === role ? 'secondary' : 'outline'}
                  className={cn('flex-1', botRole === role && 'border border-primary/60')}
                  accessibilityState={{ selected: botRole === role }}
                  onPress={() => setBotRole(role)}
                >
                  <Text>{role === 'ADMIN' ? 'Admin' : 'Member'}</Text>
                </Button>
              ))}
              <Button disabled={botBusy || !botHandle.trim()} onPress={addBot}>
                <Text>Add</Text>
              </Button>
            </View>
            <Text
              className={cn(
                'text-sm',
                botMessage
                  ? botMessage.ok
                    ? 'text-emerald-500'
                    : 'text-destructive'
                  : 'text-muted-foreground'
              )}
            >
              {botMessage?.text ??
                'Bots can read and send messages in every channel. Only the server owner can add admin bots.'}
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
                  variant="ghost"
                  disabled={botBusy}
                  accessibilityLabel={`Remove ${member.displayName || member.username}`}
                  onPress={() => void removeBot(member.userId)}
                >
                  <Text className="text-destructive">Remove</Text>
                </Button>
              </View>
            ))}
          </View>
        </SettingsGroup>
      </SettingsPage>
      <AvatarCrop
        image={crop}
        onClose={() => setCrop(null)}
        onCrop={(uri) => {
          setCrop(null);
          void uploadPicture(uri, 'image/png');
        }}
        title="Crop server picture"
        description="Adjust the image to fit your server icon."
        actionLabel="Use picture"
      />
    </>
  );
}
