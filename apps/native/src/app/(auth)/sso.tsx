// Port of apps/frontend/src/routes/sso/+page.svelte
import { zodResolver } from '@hookform/resolvers/zod';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { AtSign, User } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { View } from 'react-native';
import { z } from 'zod';
import { AuthCard, AuthField, ButtonLabel } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { safeRedirect } from '@/lib/safe-redirect';
import { useSession } from '@/lib/session';
import { claimSignOnCode, clearSignOn, pendingSignOn } from '@/lib/sso';

const signupSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2, 'At least 2 characters.')
    .max(32, 'At most 32 characters.')
    .regex(/^[a-zA-Z0-9._]+$/, 'Letters, numbers, dots, underscores only.'),
  displayName: z.string().trim().max(64, 'At most 64 characters.'),
});

export default function SignOn() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const session = useSession();
  const [pending] = useState(pendingSignOn);
  const [error, setError] = useState(params.error ?? '');
  const [signup, setSignup] = useState<{ provider: string; email: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const { control, handleSubmit, reset } = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    mode: 'onChange',
    defaultValues: { username: '', displayName: '' },
  });
  const username = useWatch({ control, name: 'username' });
  const next = safeRedirect(pending?.redirect ?? null) as Href;

  useEffect(() => {
    const code = params.code;
    if (params.error) return clearSignOn();
    // the same deep link can arrive twice on Android: the second screen just steps aside
    if (code && !claimSignOnCode(code)) return router.back();
    if (!code || !pending) {
      setError('This sign-in was started somewhere else. Start again from this app.');
      return;
    }

    void session.finishSignOn(code, pending.verifier).then((result) => {
      if (!result.ok) {
        setError(result.error);
        return clearSignOn();
      }
      if (result.result.status === 'signup') {
        setSignup(result.result);
        reset({
          username: result.result.username ?? '',
          displayName: result.result.displayName ?? '',
        });
        return;
      }
      clearSignOn();
      if (result.result.status === 'linked') router.back();
      else router.replace(next);
    });
    // only once, for the code this screen opened with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createAccount = handleSubmit(async (data) => {
    setLoading(true);
    setError('');
    const result = await session.signOnSignup({
      code: params.code!,
      verifier: pending!.verifier,
      username: data.username,
      displayName: data.displayName || undefined,
    });
    setLoading(false);
    if (!result.ok) return setError(result.error);
    clearSignOn();
    router.replace(next);
  });

  if (signup) {
    return (
      <AuthCard
        title="Pick your username"
        description={`You're new on ${anchor().homeServer}. Your ${signup.provider} account${signup.email ? ` (${signup.email})` : ''} will sign you in from now on.`}
      >
        <View className="gap-4">
          <AuthField
            control={control}
            name="username"
            label="Username"
            icon={AtSign}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username-new"
            textContentType="username"
            maxLength={32}
          />
          <Text className="text-xs text-muted-foreground">
            Handle preview:{' '}
            <Text className="font-mono text-xs">
              @{username || 'username'}:{anchor().homeServer}
            </Text>
          </Text>
          <AuthField
            control={control}
            name="displayName"
            label={
              <>
                Display name <Text className="text-sm text-muted-foreground">(optional)</Text>
              </>
            }
            icon={User}
            textContentType="nickname"
            maxLength={64}
            returnKeyType="go"
            onSubmitEditing={createAccount}
          />
          <Button size="lg" className="w-full" disabled={loading} onPress={createAccount}>
            <ButtonLabel loading={loading} loadingText="Creating account…" text="Create account" />
          </Button>
          {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
        </View>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={error ? 'Could not sign you in' : 'Signing you in…'}
      description={error || undefined}
    >
      {error ? (
        <Button variant="outline" onPress={() => router.replace('/login' as Href)}>
          <Text>Back to sign in</Text>
        </Button>
      ) : (
        <View className="items-center py-6">
          <Spinner />
        </View>
      )}
    </AuthCard>
  );
}
