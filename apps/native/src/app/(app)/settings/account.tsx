// Port of the "account" tab of apps/frontend/src/lib/components/settings-dialog.svelte
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Camera } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { z } from 'zod';
import { AvatarCrop } from '@/components/avatar-crop';
import { Avatar } from '@/components/avatar';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { SettingsRow } from '@/components/settings-row';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/input';
import { anchor } from '@/lib/anchor';
import { chat } from '@/lib/chat-state';
import { session, useSession } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { useThemeColors } from '@/lib/theme';
import { cn } from '@/lib/utils';

type Target = 'avatar' | 'banner';

const imageTypeSchema = z.enum(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const hexSchema = z.string().regex(/^#[0-9A-F]{6}$/);

// no color picker on a phone: a few good colors, or type a hex
const presets = [
  '#E11D48',
  '#EA580C',
  '#D97706',
  '#65A30D',
  '#059669',
  '#0D9488',
  '#0891B2',
  '#2563EB',
  '#4F46E5',
  '#7C3AED',
  '#C026D3',
  '#DB2777',
];

const crops = {
  avatar: {
    width: 512,
    height: 512,
    title: 'Crop Avatar',
    description: 'Adjust the image to fit your profile.',
    action: 'Use Avatar',
  },
  banner: {
    width: 960,
    height: 320,
    title: 'Crop Profile Banner',
    description: 'Adjust the image to fit your profile banner.',
    action: 'Use Banner',
  },
};

// the profile changed: reload it and tell the open chat, like the web does after each save
async function syncProfile() {
  const user = await session().refresh();
  if (!user) return;
  chat().updateUserProfile(user.id, {
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    avatarColor: user.avatarColor,
    speakingRingColor: user.speakingRingColor,
    bannerUrl: user.bannerUrl,
    about: user.about,
  });
}

export default function Account() {
  const user = useSession((s) => s.user);
  const circleIcons = useSettings((s) => s.circleIcons);
  const colors = useThemeColors();

  const savedAvatarColor = user?.avatarColor ?? '#6366F1';
  const savedSpeakingRing = user?.speakingRingColor ?? '#00d492';
  const [about, setAbout] = useState('');
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutError, setAboutError] = useState<string | null>(null);
  const [aboutSaved, setAboutSaved] = useState(false);
  const [pending, setPending] = useState<{ avatar?: string; ring?: string }>({});
  const [editingColor, setEditingColor] = useState<'avatar' | 'ring' | null>(null);
  const [colorLoading, setColorLoading] = useState(false);
  const [colorError, setColorError] = useState<string | null>(null);
  const [crop, setCrop] = useState<{
    target: Target;
    uri: string;
    width: number;
    height: number;
  } | null>(null);
  const [mediaLoading, setMediaLoading] = useState<Target | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const avatarColor = pending.avatar ?? savedAvatarColor;
  const speakingRing = pending.ring ?? savedSpeakingRing;
  const displayName = user?.displayName || user?.username || '?';
  const handle = user?.handle || `@${user?.username ?? 'you'}`;

  useEffect(() => setAbout(user?.about ?? ''), [user?.about]);

  async function selectMedia(target: Target) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;

    const type = imageTypeSchema.safeParse(asset.mimeType);
    if (!type.success) {
      setMediaError('Choose a GIF, JPEG, PNG, or WebP image.');
      return;
    }

    setMediaError(null);
    if (type.data === 'image/gif') void uploadMedia(asset.uri, target, 'image/gif');
    else setCrop({ target, uri: asset.uri, width: asset.width, height: asset.height });
  }

  async function uploadMedia(uri: string, target: Target, type: 'image/gif' | 'image/png') {
    setMediaLoading(target);
    setMediaError(null);

    try {
      // React Native sends a file as a `{ uri, name, type }` form part. Eden only builds multipart bodies
      // from web `File`s, so this one request goes through fetch (cookies come from the phone's cookie store).
      const form = new FormData();
      form.append(target, {
        uri,
        name: `${target}.${type === 'image/gif' ? 'gif' : 'png'}`,
        type,
      } as unknown as Blob);
      const response = await fetch(`${anchor().baseUrl}/user/${target}`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      await syncProfile();
    } catch {
      setMediaError(`Could not upload your ${target}.`);
    } finally {
      setMediaLoading(null);
    }
  }

  async function saveAbout() {
    setAboutLoading(true);
    setAboutError(null);
    setAboutSaved(false);

    try {
      const result = await anchor().client.user.about.post({ about: about.trim() || null });
      if (result.error || !result.data || 'error' in result.data) {
        setAboutError('Could not update your about section.');
        return;
      }

      await syncProfile();
      setAboutSaved(true);
    } catch {
      setAboutError('Could not update your about section.');
    } finally {
      setAboutLoading(false);
    }
  }

  async function saveColors() {
    const avatar = hexSchema.safeParse(avatarColor.toUpperCase());
    const ring = hexSchema.safeParse(speakingRing.toUpperCase());
    if (!avatar.success || !ring.success) {
      setColorError('Enter a color like #6366F1.');
      return;
    }

    setColorLoading(true);
    setColorError(null);

    try {
      const result = await anchor().client.user.avatar.color.post({
        avatarColor: avatar.data,
        speakingRingColor: ring.data,
      });
      if (result.error || !result.data || 'error' in result.data) {
        setColorError('Could not update your avatar color.');
        return;
      }

      await syncProfile();
      closeColors();
    } catch {
      setColorError('Could not update your avatar color.');
    } finally {
      setColorLoading(false);
    }
  }

  function closeColors() {
    setEditingColor(null);
    setPending({});
    setColorError(null);
  }

  const setColor = (value: string) =>
    setPending({ ...pending, [editingColor === 'ring' ? 'ring' : 'avatar']: value });
  const editedColor = editingColor === 'ring' ? speakingRing : avatarColor;
  const validColor = (value: string, fallback: string) =>
    hexSchema.safeParse(value.toUpperCase()).success ? value : fallback;

  const colorButton = (label: string, color: string, which: 'avatar' | 'ring') => (
    <Button
      variant="outline"
      size="sm"
      className="gap-2"
      accessibilityLabel={label}
      onPress={() => setEditingColor(which)}
    >
      <View
        className="size-4 border border-black/15"
        style={{ backgroundColor: validColor(color, '#000000') }}
      />
      <Text className="font-mono text-xs">{color.toUpperCase()}</Text>
    </Button>
  );

  const mediaDisabled = mediaLoading !== null;

  return (
    <SettingsPage description="How you appear to everyone on Novarum.">
      <View className="overflow-hidden bg-card">
        <Pressable
          accessibilityLabel="Change profile banner"
          disabled={mediaDisabled}
          onPress={() => selectMedia('banner')}
          className="aspect-[3/1] w-full items-center justify-center"
          style={{ backgroundColor: avatarColor }}
        >
          {user?.bannerUrl ? (
            <Image
              source={{ uri: user.bannerUrl }}
              contentFit="cover"
              autoplay={false}
              style={{ position: 'absolute', width: '100%', height: '100%' }}
            />
          ) : null}
          <View className="flex-row items-center gap-2 bg-black/45 px-3 py-1.5">
            {mediaLoading === 'banner' ? (
              <Spinner />
            ) : (
              <Icon as={Camera} size={16} className="text-white" />
            )}
            <Text className="text-xs font-medium text-white">
              {mediaLoading === 'banner' ? 'Uploading…' : 'Change banner'}
            </Text>
          </View>
        </Pressable>

        <View className="flex-row items-end gap-4 px-4 pb-4">
          <Pressable
            accessibilityLabel="Change profile picture"
            disabled={mediaDisabled}
            onPress={() => selectMedia('avatar')}
            className={cn(
              '-mt-10 size-20 shrink-0 overflow-hidden border-4 border-card',
              circleIcons && 'rounded-full'
            )}
            style={{ backgroundColor: avatarColor }}
          >
            <Avatar src={user?.avatarUrl} name={displayName} className="size-full bg-transparent" />
            <View className="absolute inset-0 items-center justify-center bg-black/30">
              {mediaLoading === 'avatar' ? (
                <Spinner />
              ) : (
                <Icon as={Camera} size={20} className="text-white" />
              )}
            </View>
          </Pressable>
          <View className="min-w-0 flex-1 pt-3">
            <Text className="text-base font-semibold" numberOfLines={1}>
              {user?.displayName || user?.username || 'Your profile'}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {handle}
            </Text>
          </View>
        </View>
        {mediaError ? (
          <Text className="px-4 pb-3 text-xs text-destructive">{mediaError}</Text>
        ) : null}
      </View>

      <SettingsGroup title="About me">
        <View>
          <Textarea
            value={about}
            onChangeText={(text) => {
              setAbout(text);
              setAboutSaved(false);
            }}
            maxLength={512}
            placeholder="What should people know about you?"
            className="border-0 bg-transparent px-4 py-3.5 text-sm"
          />
          <View className="flex-row items-center justify-between gap-3 px-4 pb-3">
            {aboutError ? (
              <Text className="text-xs text-destructive">{aboutError}</Text>
            ) : (
              <Text className="text-xs text-muted-foreground">{about.length}/512</Text>
            )}
            <Button size="sm" disabled={aboutLoading} onPress={saveAbout}>
              <Text>{aboutLoading ? 'Saving…' : aboutSaved ? 'Saved' : 'Save about'}</Text>
            </Button>
          </View>
        </View>
      </SettingsGroup>

      <SettingsGroup title="Colors" description="Used for your avatar and when you speak in voice.">
        <SettingsRow
          title="Avatar color"
          description="Shown behind your picture and on your banner."
        >
          {colorButton('Change avatar color', avatarColor, 'avatar')}
        </SettingsRow>
        <SettingsRow title="Speaking ring" description="The outline around you while you talk.">
          {colorButton('Change speaking ring color', speakingRing, 'ring')}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Sign-in details">
        <SettingsRow title="Display name">
          <Text className="max-w-48 text-sm text-muted-foreground" numberOfLines={1}>
            {user?.displayName ?? ''}
          </Text>
        </SettingsRow>
        <SettingsRow title="Email address" description="Only visible to you.">
          <Text className="max-w-48 text-sm text-muted-foreground" numberOfLines={1}>
            {user?.email ?? ''}
          </Text>
        </SettingsRow>
      </SettingsGroup>

      <Sheet open={editingColor !== null} onClose={closeColors}>
        <View className="gap-4 px-4 pb-2">
          <Text className="text-base font-semibold">
            {editingColor === 'ring' ? 'Speaking ring' : 'Avatar color'}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {presets.map((preset) => (
              <Pressable
                key={preset}
                accessibilityLabel={preset}
                onPress={() => setColor(preset)}
                className={cn(
                  'size-10 border-2',
                  editedColor.toUpperCase() === preset ? 'border-foreground' : 'border-transparent'
                )}
                style={{ backgroundColor: preset }}
              />
            ))}
          </View>
          <BottomSheetTextInput
            value={editedColor}
            onChangeText={(text) =>
              setColor(`#${text.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)}`.toUpperCase())
            }
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="#6366F1"
            placeholderTextColor={colors['muted-foreground']}
            style={{
              height: 44,
              paddingHorizontal: 12,
              borderWidth: 1,
              borderColor: colors.input,
              color: colors.foreground,
              backgroundColor: colors.background,
              fontFamily: 'IBMPlexMono_400Regular',
            }}
          />
          <View className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-xs text-destructive">{colorError ?? ''}</Text>
            <Button variant="ghost" size="sm" disabled={colorLoading} onPress={closeColors}>
              <Text>Cancel</Text>
            </Button>
            <Button size="sm" disabled={colorLoading} onPress={saveColors}>
              <Text>{colorLoading ? 'Saving…' : 'Save colors'}</Text>
            </Button>
          </View>
        </View>
      </Sheet>

      <AvatarCrop
        image={crop}
        onClose={() => setCrop(null)}
        onCrop={(uri) => {
          if (crop) void uploadMedia(uri, crop.target, 'image/png');
          setCrop(null);
        }}
        title={crop ? crops[crop.target].title : undefined}
        description={crop ? crops[crop.target].description : undefined}
        actionLabel={crop ? crops[crop.target].action : undefined}
        outputWidth={crop ? crops[crop.target].width : undefined}
        outputHeight={crop ? crops[crop.target].height : undefined}
      />
    </SettingsPage>
  );
}
