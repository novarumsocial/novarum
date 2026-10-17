// `/guilds/<server>` (web links, invites): show that server in the hub
import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { chat } from '@/lib/chat-state';
import { goHome } from '@/lib/navigation';

export default function ServerLink() {
  const { server } = useLocalSearchParams<{ server: string }>();

  useEffect(() => {
    chat().selectServer(server === 'dms' ? undefined : server);
    goHome();
  }, [server]);

  return null;
}
