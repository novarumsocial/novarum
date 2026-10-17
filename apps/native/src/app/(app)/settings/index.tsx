// Port of the nav and footer of apps/frontend/src/lib/components/settings-dialog.svelte
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import {
  Bell,
  ChevronRight,
  Languages,
  LogOut,
  Palette,
  ShieldCheck,
  User,
  Volume2,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { SettingsGroup } from '@/components/settings-group';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { getAnchorInfo } from '@/lib/api';
import { session, useSession } from '@/lib/session';

const groups: { label: string; pages: { href: string; title: string; icon: LucideIcon }[] }[] = [
  {
    label: 'You',
    pages: [
      { href: '/settings/account', title: 'Account', icon: User },
      { href: '/settings/security', title: 'Privacy & security', icon: ShieldCheck },
    ],
  },
  {
    label: 'App',
    pages: [
      { href: '/settings/appearance', title: 'Appearance', icon: Palette },
      { href: '/settings/notifications', title: 'Notifications', icon: Bell },
      { href: '/settings/voice', title: 'Voice & audio', icon: Volume2 },
      { href: '/settings/language', title: 'Language & time', icon: Languages },
    ],
  },
];

const row = 'h-12 flex-row items-center gap-3 px-4 active:bg-accent';

export default function Settings() {
  const user = useSession((s) => s.user);
  const insets = useSafeAreaInsets();
  const [anchorVersion, setAnchorVersion] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const appVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version;

  useEffect(() => {
    void getAnchorInfo(anchor().homeServer)
      .then((info) => setAnchorVersion(info.version ?? null))
      .catch(() => {});
  }, []);

  async function logout() {
    setLoggingOut(true);
    try {
      await session().logout();
      session().forget(anchor().homeServer);
      router.replace('/login');
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, padding: 16, paddingBottom: insets.bottom + 32 }}
    >
      <View className="flex-row items-center gap-3 px-1">
        <Avatar
          src={user?.avatarUrl}
          bgColor={user?.avatarColor}
          name={user?.displayName || user?.username || '?'}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium" numberOfLines={1}>
            {user?.displayName || user?.username || 'You'}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {user?.handle || `@${user?.username ?? 'you'}`}
          </Text>
        </View>
      </View>

      {groups.map((group) => (
        <SettingsGroup key={group.label} title={group.label}>
          {group.pages.map((page) => (
            <Pressable
              key={page.href}
              className={row}
              onPress={() => router.push(page.href as never)}
            >
              <Icon as={page.icon} size={18} className="text-muted-foreground" />
              <Text className="flex-1 text-sm">{page.title}</Text>
              <Icon as={ChevronRight} size={16} className="text-muted-foreground" />
            </Pressable>
          ))}
        </SettingsGroup>
      ))}

      <SettingsGroup>
        <Pressable className={row} disabled={loggingOut} onPress={logout}>
          {loggingOut ? <Spinner /> : <Icon as={LogOut} size={18} className="text-destructive" />}
          <Text className="flex-1 text-sm text-destructive">Log out</Text>
        </Pressable>
      </SettingsGroup>

      <Text className="px-1 text-[11px] text-muted-foreground">
        Novarum v{appVersion} · Anchor {anchorVersion ?? 'unknown'}
      </Text>
    </ScrollView>
  );
}
