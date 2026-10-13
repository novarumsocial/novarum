// Port of apps/frontend/src/routes/login/+page.svelte
import { zodResolver } from '@hookform/resolvers/zod';
import { router, type Href } from 'expo-router';
import { ArrowLeft, AtSign, Lock, LogIn, Mail, Server, Smartphone } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Pressable, TextInput, View } from 'react-native';
import { z } from 'zod';
import { AuthCard, AuthField, ButtonLabel, TextLink } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useAuthParams } from '@/lib/safe-redirect';
import { useSession, type MfaMethod } from '@/lib/session';
import { cn } from '@/lib/utils';

const loginSchema = z.object({
  homeServer: z
    .string()
    .trim()
    .min(1, 'Pick a home server.')
    .regex(
      /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?$/,
      'Enter a valid server address.'
    ),
  username: z
    .string()
    .trim()
    .min(2, 'At least 2 characters.')
    .max(32, 'At most 32 characters.')
    .regex(/^[a-zA-Z0-9._]+$/, 'Letters, numbers, dots, underscores only.'),
  password: z.string().min(1, 'Enter your password.'),
});

const mfaCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the six-digit verification code.');

// six boxes drawn over one invisible input, so the OS one-time-code autofill and paste just work
function OtpInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable onPress={() => ref.current?.focus()} className="flex-row justify-center gap-2">
      {Array.from({ length: 6 }, (_, i) => (
        <View
          key={i}
          className={cn(
            'size-11 items-center justify-center border border-input bg-background',
            focused && i === Math.min(value.length, 5) && 'border-primary'
          )}
        >
          <Text className="font-mono">{value[i] ?? ''}</Text>
        </View>
      ))}
      <TextInput
        ref={ref}
        autoFocus
        value={value}
        editable={!disabled}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={6}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        accessibilityLabel="Six-digit verification code"
        caretHidden
        style={{ position: 'absolute', inset: 0, opacity: 0 }}
      />
    </Pressable>
  );
}

export default function Login() {
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [mfaChallenge, setMfaChallenge] = useState('');
  const [mfaMethods, setMfaMethods] = useState<MfaMethod[]>([]);
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('EMAIL');
  const [mfaCode, setMfaCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [showLoginOptions, setShowLoginOptions] = useState(false);
  const session = useSession();
  const { add, query, done } = useAuthParams();

  useEffect(() => {
    if (add) return;

    void session.refresh().then((user) => {
      if (user) done();
    });
    // only once, when the screen opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { control, handleSubmit, setFocus } = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { homeServer: 'novarum.me', username: '', password: '' },
  });

  const submit = handleSubmit(async (data) => {
    setLoading(true);
    setSubmitError('');

    const result = await session.login(data);

    if (!result.ok) {
      setSubmitError(result.error);
      setLoading(false);
      return;
    }

    if ('mfa' in result) {
      setMfaChallenge(result.mfa.challenge);
      setMfaMethods(result.mfa.methods);
      setMfaMethod(result.mfa.methods.includes('TOTP') ? 'TOTP' : 'EMAIL');
      setLoading(false);
      return;
    }

    done();
  });

  async function verifyMfa(code: string) {
    const parsed = mfaCodeSchema.safeParse(code);
    if (!parsed.success) {
      setSubmitError(parsed.error.issues[0]?.message ?? '');
      return;
    }

    setLoading(true);
    setSubmitError('');
    const result = await session.completeMfa(mfaChallenge, mfaMethod, parsed.data);
    if (!result.ok) {
      setSubmitError(result.error);
      setLoading(false);
      return;
    }

    done();
  }

  async function sendEmailCode() {
    setSendingEmail(true);
    setSubmitError('');
    const result = await session.sendMfaEmail(mfaChallenge);
    setSendingEmail(false);

    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }

    setEmailSent(true);
    setMfaCode('');
  }

  function selectMfaMethod(method: MfaMethod) {
    setMfaMethod(method);
    setMfaCode('');
    setSubmitError('');
    setShowLoginOptions(false);
  }

  function restartLogin() {
    setMfaChallenge('');
    setMfaMethods([]);
    setMfaCode('');
    setEmailSent(false);
    setShowLoginOptions(false);
    setSubmitError('');
  }

  const changeCode = (code: string) => {
    setMfaCode(code);
    if (code.length === 6) void verifyMfa(code);
  };

  const description = mfaChallenge
    ? mfaMethod === 'EMAIL'
      ? emailSent
        ? 'Enter the code sent to the email on your account.'
        : 'Get a one-time code sent to the email on your account.'
      : 'Enter the current code from your authenticator app.'
    : 'Sign in to your home server to continue.';

  const error = submitError ? (
    <Text className="text-center text-sm text-destructive" accessibilityLiveRegion="polite">
      {submitError}
    </Text>
  ) : null;

  return (
    <AuthCard
      title={mfaChallenge ? 'Verify it’s you' : 'Welcome back'}
      description={description}
      footer={
        mfaChallenge ? (
          <Pressable onPress={restartLogin} hitSlop={14} className="flex-row items-center gap-1.5">
            <Icon as={ArrowLeft} size={14} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Back to sign in</Text>
          </Pressable>
        ) : (
          <>
            <Text className="text-xs text-muted-foreground">Don't have an account?</Text>
            <TextLink onPress={() => router.push(`/register${query}` as Href)}>Register</TextLink>
          </>
        )
      }
    >
      {mfaChallenge ? (
        <View className="gap-5">
          {showLoginOptions ? (
            <View className="gap-1 border border-border bg-background/40 p-2">
              <Text className="px-2 pt-1 text-xs font-medium text-muted-foreground">
                Choose how to verify
              </Text>
              {mfaMethods.includes('TOTP') && (
                <Pressable
                  onPress={() => selectMfaMethod('TOTP')}
                  className="flex-row items-center gap-3 px-3 py-2.5 active:bg-accent"
                >
                  <Icon as={Smartphone} size={16} />
                  <View>
                    <Text className="text-sm">Authenticator app</Text>
                    <Text className="text-xs text-muted-foreground">Use a rotating code</Text>
                  </View>
                </Pressable>
              )}
              {mfaMethods.includes('EMAIL') && (
                <Pressable
                  onPress={() => selectMfaMethod('EMAIL')}
                  className="flex-row items-center gap-3 px-3 py-2.5 active:bg-accent"
                >
                  <Icon as={Mail} size={16} />
                  <View>
                    <Text className="text-sm">Email code</Text>
                    <Text className="text-xs text-muted-foreground">Send a one-time code</Text>
                  </View>
                </Pressable>
              )}
            </View>
          ) : mfaMethod === 'EMAIL' && !emailSent ? (
            <View className="items-center gap-3 border border-border bg-background/40 p-4">
              <Icon as={Mail} size={24} className="text-primary" />
              <Text className="text-center text-sm text-muted-foreground">
                Ready? Click that fancy button below to send a one-time code to the email on your
                account.
              </Text>
              <Button className="w-full" disabled={sendingEmail} onPress={sendEmailCode}>
                {sendingEmail ? (
                  <>
                    <Spinner />
                    <Text>Sending…</Text>
                  </>
                ) : (
                  <>
                    <Icon as={Mail} size={16} className="text-primary-foreground" />
                    <Text>Send email code</Text>
                  </>
                )}
              </Button>
            </View>
          ) : (
            <>
              <View className="gap-3">
                <Text className="text-center text-sm font-medium">Verification code</Text>
                <OtpInput value={mfaCode} onChange={changeCode} disabled={loading} />
              </View>

              <Button
                size="lg"
                className="w-full"
                disabled={loading || mfaCode.length !== 6}
                onPress={() => verifyMfa(mfaCode)}
              >
                <ButtonLabel loading={loading} loadingText="Verifying…" text="Verify and sign in" />
              </Button>

              {mfaMethod === 'EMAIL' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={sendingEmail}
                  onPress={sendEmailCode}
                >
                  <Text className="text-muted-foreground">
                    {sendingEmail ? 'Sending…' : 'Send a new code'}
                  </Text>
                </Button>
              )}
            </>
          )}

          {mfaMethods.length > 1 && !showLoginOptions && (
            <Button variant="outline" className="w-full" onPress={() => setShowLoginOptions(true)}>
              <Text>Try another way</Text>
            </Button>
          )}

          {error}
        </View>
      ) : (
        <View className="gap-4">
          <AuthField
            control={control}
            name="homeServer"
            label="Home server"
            icon={Server}
            placeholder="novarum.me"
            autoComplete="url"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => setFocus('username')}
          />
          <AuthField
            control={control}
            name="username"
            label="Username"
            icon={AtSign}
            placeholder="alice"
            autoComplete="username"
            textContentType="username"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => setFocus('password')}
          />
          <AuthField
            control={control}
            name="password"
            label="Password"
            icon={Lock}
            labelRight={
              <Pressable
                accessibilityRole="link"
                hitSlop={14}
                onPress={() => router.push(`/reset-password${query}` as Href)}
              >
                <Text className="text-xs text-muted-foreground">Forgot password?</Text>
              </Pressable>
            }
            secureTextEntry
            placeholder="••••••••"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
          />

          <Button size="lg" className="w-full" disabled={loading} onPress={submit}>
            <ButtonLabel loading={loading} loadingText="Signing in…" text="Sign in" icon={LogIn} />
          </Button>

          {submitError ? <Text className="text-sm text-destructive">{submitError}</Text> : null}
        </View>
      )}
    </AuthCard>
  );
}
