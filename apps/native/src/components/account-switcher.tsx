// Port of the account popover in apps/frontend/src/lib/components/user-area.svelte, as a bottom sheet
import { router } from 'expo-router';
import { Check, Plus, X } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { useAnchor } from '@/lib/anchor';
import { session, useSession } from '@/lib/session';
import { Avatar } from './avatar';
import { Icon } from './ui/icon';
import { Sheet } from './ui/sheet';
import { Text } from './ui/text';

export function AccountSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useSession((s) => s.accounts);
  const homeServer = useAnchor((s) => s.homeServer);

  // switching re-boots the app on the new homeserver; the web does this with a page reload
  const switchTo = async (server: string) => {
    onClose();
    await session().switchAccount(server);
    router.replace('/guilds');
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <Text className="px-4 pb-1 text-xs font-medium text-muted-foreground">Accounts</Text>
      {accounts.map((account) => {
        const active = account.homeServer === homeServer;
        return (
          <View key={account.homeServer} className="flex-row items-center">
            <Pressable
              disabled={active}
              onPress={() => switchTo(account.homeServer)}
              className={`h-14 flex-1 flex-row items-center gap-3 px-4 ${active ? 'bg-accent/50' : 'active:bg-accent'}`}
            >
              <Avatar
                src={account.avatarUrl}
                name={account.displayName || account.username}
                bgColor={account.avatarColor}
                className="size-9"
              />
              <View className="flex-1">
                <Text className="text-sm font-medium" numberOfLines={1}>
                  {account.displayName || account.username}
                </Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {account.homeServer}
                </Text>
              </View>
              {active && <Icon as={Check} size={18} className="text-primary" />}
            </Pressable>
            {!active && (
              <Pressable
                accessibilityLabel={`Forget ${account.homeServer}`}
                onPress={() => session().forget(account.homeServer)}
                className="h-14 w-12 items-center justify-center active:bg-accent"
              >
                <Icon as={X} size={16} className="text-muted-foreground" />
              </Pressable>
            )}
          </View>
        );
      })}
      <Pressable
        onPress={() => {
          onClose();
          router.push('/login?add');
        }}
        className="h-14 flex-row items-center gap-3 px-4 active:bg-accent"
      >
        <View className="size-9 items-center justify-center">
          <Icon as={Plus} size={18} className="text-muted-foreground" />
        </View>
        <Text className="text-sm">Add account</Text>
      </Pressable>
    </Sheet>
  );
}
