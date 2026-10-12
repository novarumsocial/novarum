// Port of apps/frontend/src/routes/register/+page.svelte
import { zodResolver } from '@hookform/resolvers/zod';
import { router, type Href } from 'expo-router';
import { AtSign, CircleCheck, Eye, EyeOff, Lock, Mail, Server, User } from 'lucide-react-native';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Pressable, View } from 'react-native';
import { z } from 'zod';
import { AuthCard, AuthField, ButtonLabel, TextLink } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useAuthParams } from '@/lib/safe-redirect';
import { useSession } from '@/lib/session';

const registerSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(2, 'At least 2 characters.')
      .max(32, 'At most 32 characters.')
      .regex(/^[a-zA-Z0-9._]+$/, 'Letters, numbers, dots, underscores only.'),
    homeserver: z
      .string()
      .trim()
      .min(1, 'Pick a home server.')
      .regex(
        /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?$/,
        'Enter a valid server address.'
      ),
    displayName: z.string().trim().max(64, 'At most 64 characters.'),
    email: z.email('Enter a valid email.'),
    password: z.string().min(8, 'At least 8 characters.'),
    confirmPassword: z.string().min(1, 'Confirm your password.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: "Passwords don't match.",
  });

const Required = () => <Text className="text-sm font-medium text-destructive">*</Text>;

const Ok = ({ children }: { children: string }) => (
  <View className="flex-row items-center gap-1">
    <Icon as={CircleCheck} size={12} className="text-emerald-400" />
    <Text className="text-xs text-emerald-400">{children}</Text>
  </View>
);

export default function Register() {
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const session = useSession();
  const { query, done } = useAuthParams();

  const { control, handleSubmit, setFocus } = useForm<z.infer<typeof registerSchema>>({
    resolver: zodResolver(registerSchema),
    mode: 'onChange',
    defaultValues: {
      username: '',
      homeserver: 'novarum.me',
      displayName: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });
  const [username, homeserver, password, confirmPassword] = useWatch({
    control,
    name: ['username', 'homeserver', 'password', 'confirmPassword'],
  });
  const handle = `@${username || 'username'}:${homeserver || 'server'}`;

  const submit = handleSubmit(async (data) => {
    setLoading(true);
    setSubmitError('');

    const result = await session.signup({
      homeServer: data.homeserver,
      username: data.username,
      displayName: data.displayName,
      email: data.email,
      password: data.password,
    });

    if (!result.ok) {
      setSubmitError(result.error);
      setLoading(false);
      return;
    }

    done();
  });

  const toggle = (
    <Pressable
      onPress={() => setShowPassword(!showPassword)}
      hitSlop={8}
      className="px-3"
      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
    >
      <Icon as={showPassword ? EyeOff : Eye} size={16} className="text-muted-foreground" />
    </Pressable>
  );

  return (
    <AuthCard
      title="Create your account"
      description="Pick a home server and username - your handle works across the federation."
      footer={
        <>
          <Text className="text-xs text-muted-foreground">Already have an account?</Text>
          <TextLink onPress={() => router.replace(`/login${query}` as Href)}>Sign in</TextLink>
        </>
      }
    >
      <View className="gap-4">
        <View className="gap-2">
          <AuthField
            control={control}
            name="username"
            label={
              <>
                Username <Required />
              </>
            }
            icon={AtSign}
            placeholder="alice"
            autoComplete="username-new"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => setFocus('homeserver')}
          />
          <AuthField
            control={control}
            name="homeserver"
            label={
              <>
                Home server <Required />
              </>
            }
            icon={Server}
            placeholder="novarum.me"
            autoComplete="url"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => setFocus('displayName')}
          />
          <Text className="text-xs text-muted-foreground">
            Handle preview: <Text className="font-mono text-xs">{handle}</Text>
          </Text>
        </View>

        <AuthField
          control={control}
          name="displayName"
          label={
            <>
              Display name <Text className="text-sm text-muted-foreground">(optional)</Text>
            </>
          }
          icon={User}
          placeholder="Alice"
          autoComplete="name"
          textContentType="nickname"
          maxLength={64}
          returnKeyType="next"
          onSubmitEditing={() => setFocus('email')}
        />

        <AuthField
          control={control}
          name="email"
          label={
            <>
              Email <Required />
            </>
          }
          icon={Mail}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          onSubmitEditing={() => setFocus('password')}
        />

        <View className="gap-1.5">
          <AuthField
            control={control}
            name="password"
            label={
              <>
                Password <Required />
              </>
            }
            icon={Lock}
            right={toggle}
            secureTextEntry={!showPassword}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            textContentType="newPassword"
            autoCapitalize="none"
            returnKeyType="next"
            onSubmitEditing={() => setFocus('confirmPassword')}
          />
          {password.length >= 8 && <Ok>Looks good</Ok>}
        </View>

        <View className="gap-1.5">
          <AuthField
            control={control}
            name="confirmPassword"
            label={
              <>
                Confirm password <Required />
              </>
            }
            icon={Lock}
            secureTextEntry={!showPassword}
            placeholder="Re-enter your password"
            autoComplete="new-password"
            textContentType="newPassword"
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={submit}
          />
          {confirmPassword && confirmPassword === password && <Ok>Matches</Ok>}
        </View>

        <Button size="lg" className="w-full" disabled={loading} onPress={submit}>
          <ButtonLabel loading={loading} loadingText="Creating account…" text="Create account" />
        </Button>

        {submitError ? <Text className="text-sm text-destructive">{submitError}</Text> : null}
      </View>
    </AuthCard>
  );
}
