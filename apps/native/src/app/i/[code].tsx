// Port of apps/frontend/src/routes/i/[code]/+page.svelte
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { ArrowRight, Check, Copy, Users } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { AuthCard, TextLink } from '@/components/auth-card';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { createAnchorClient, discoverAnchor, normalizeHomeServer } from '@/lib/api';
import { useSession } from '@/lib/session';

type InviteState = {
  invite: {
    id: string;
    code: string;
    guildId: string;
    creatorId: string;
    createdAt: Date | string;
    expiresAt: Date | string | null;
  };
  guild: {
    id: string;
    name: string;
    description: string | null;
    avatarUrl: string | null;
    memberCount: number;
  };
};

const acceptSchema = z.object({
  error: z.string().optional(),
  guildId: z.string().optional(),
  guild: z.object({ id: z.string() }).optional(),
});
const acceptErrorSchema = z.object({
  status: z.coerce.number().optional(),
  value: z.object({ error: z.string() }).optional(),
});

function decodeInviteParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
    .slice(0, 2);
}

export default function InvitePage() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const session = useSession();
  const raw = decodeInviteParam(code ?? '');
  const atIdx = raw.lastIndexOf('@');
  const rawInviteCode = atIdx !== -1 ? raw.slice(0, atIdx) : raw;
  const inviteCode = rawInviteCode.startsWith('$') ? rawInviteCode.slice(1) : rawInviteCode;
  const homeServer = atIdx !== -1 ? raw.slice(atIdx + 1) : raw;
  const normalizedHomeServer = normalizeHomeServer(homeServer);

  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<InviteState | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [copied, setCopied] = useState(false);
  const userHomeServer = anchor().homeServer;

  const inviteUrl = `https://app.novarum.me/i/${raw}`;
  const loginHref = `/login?redirect=${encodeURIComponent(`/i/${raw}`)}` as Href;

  const lookupInvite = useCallback(async () => {
    let inviteClient: ReturnType<typeof createAnchorClient>;

    try {
      inviteClient = createAnchorClient(await discoverAnchor(normalizedHomeServer));
    } catch {
      setError('Could not discover this home server.');
      setLoading(false);
      return;
    }

    const result = await inviteClient.invite({ code: inviteCode }).get();

    if (result.error || !result.data || 'error' in result.data) {
      setError('This invite is invalid or has expired.');
      setLoading(false);
      return;
    }

    setInvite(result.data);
    setLoading(false);
  }, [inviteCode, normalizedHomeServer]);

  useEffect(() => {
    if (inviteCode && homeServer) void lookupInvite();
  }, [inviteCode, homeServer, lookupInvite]);

  useEffect(() => {
    if (!session.initialized) void session.refresh();
    // only once, when the screen opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function acceptInvite() {
    setAccepting(true);
    setError('');
    const remoteInvite = normalizedHomeServer !== userHomeServer;

    if (!session.user) {
      router.replace(loginHref);
      return;
    }

    if (remoteInvite) {
      try {
        await anchor().setHomeServer(userHomeServer);
      } catch {
        setError('Could not discover your home server.');
        setAccepting(false);
        return;
      }
    }

    const result = await anchor().client.invite.accept.post({
      code: inviteCode,
      ...(remoteInvite ? { homeserver: normalizedHomeServer } : {}),
    });
    const data = acceptSchema.safeParse(result.data);

    if (result.error || !data.success || data.data.error) {
      const failure = acceptErrorSchema.safeParse(result.error);
      const status = failure.success ? failure.data.status : undefined;
      const err =
        (data.success && data.data.error) ||
        (failure.success && failure.data.value?.error) ||
        'Could not accept invite.';

      if (
        status === 401 ||
        err.toLowerCase().includes('unauthorized') ||
        err.toLowerCase().includes('not authenticated') ||
        err.toLowerCase().includes('no session')
      ) {
        router.replace(loginHref);
        return;
      }

      setError(err);
      setAccepting(false);
      return;
    }

    setAccepted(true);
    const guildId = data.data.guildId ?? data.data.guild?.id;
    // dismissTo: when the invite was opened over a running app, go back to that app instead of stacking a second one
    router.dismissTo((guildId ? `/guilds/${encodeURIComponent(guildId)}` : '/guilds') as Href);
  }

  async function copyInvite() {
    await Clipboard.setStringAsync(inviteUrl);
    setCopied(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    setCopied(false);
  }

  const register = <TextLink onPress={() => router.push('/register')}>Create an account</TextLink>;

  if (loading || !session.initialized) {
    return (
      <AuthCard title="Looking up invite…">
        <View className="items-center py-8">
          <Spinner size="large" />
        </View>
      </AuthCard>
    );
  }

  if (accepted) {
    return (
      <AuthCard
        title="You joined the server!"
        description={`Redirecting you to ${invite?.guild.name ?? 'the server'}…`}
        centered={false}
      />
    );
  }

  if (error && !invite) {
    return (
      <AuthCard
        title="Invite not found"
        description={error}
        centered={false}
        footer={
          <>
            <Text className="text-xs text-muted-foreground">Want to start your own?</Text>
            {register}
          </>
        }
      >
        <Text className="text-sm text-muted-foreground">
          The invite link you're trying to use may have expired or is invalid. Ask the server owner
          for a new one.
        </Text>
      </AuthCard>
    );
  }

  if (!invite) return null;

  return (
    <AuthCard
      title="You're invited!"
      description="Join your friends on this guild."
      footer={
        <>
          <Text className="text-xs text-muted-foreground">Not {homeServer}?</Text>
          <TextLink onPress={() => router.push(loginHref)}>
            Sign in with a different account
          </TextLink>
        </>
      }
    >
      <View className="gap-5">
        <View className="flex-row items-center gap-4 border border-border bg-muted/30 px-4 py-3">
          <Avatar
            src={invite.guild.avatarUrl}
            name={invite.guild.name}
            fallback={initialsFor(invite.guild.name)}
          />
          <View className="min-w-0 flex-1">
            <Text className="font-medium" numberOfLines={1}>
              {invite.guild.name}
            </Text>
            <View className="flex-row items-center gap-1">
              <Icon as={Users} size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {invite.guild.memberCount} member{invite.guild.memberCount !== 1 ? 's' : ''} · @
                {homeServer}
              </Text>
            </View>
          </View>
        </View>

        <View className="gap-1.5">
          <Label className="text-xs">Invite Link</Label>
          <View className="flex-row gap-2">
            <Input value={inviteUrl} editable={false} className="flex-1 font-mono text-xs" />
            <Button
              variant="outline"
              size="icon"
              accessibilityLabel="Copy invite link"
              onPress={copyInvite}
            >
              <Icon as={copied ? Check : Copy} size={16} />
            </Button>
          </View>
        </View>

        <Button size="lg" className="w-full" disabled={accepting} onPress={acceptInvite}>
          {accepting ? (
            <>
              <Spinner />
              <Text>Joining…</Text>
            </>
          ) : (
            <>
              <Text>Accept Invite</Text>
              <Icon as={ArrowRight} size={16} className="text-primary-foreground" />
            </>
          )}
        </Button>

        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      </View>
    </AuthCard>
  );
}
