// Port of apps/frontend/src/routes/reset-password/+page.svelte
import { zodResolver } from '@hookform/resolvers/zod';
import { router, type Href } from 'expo-router';
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Server,
} from 'lucide-react-native';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Pressable, View } from 'react-native';
import { z } from 'zod';
import { AuthCard, AuthField, ButtonLabel, TextLink } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { useAuthParams } from '@/lib/safe-redirect';
import { getErrorMessage } from '@/lib/session';

const homeServerSchema = z
  .string()
  .trim()
  .min(1, 'Pick a home server.')
  .regex(
    /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?$/,
    'Enter a valid server address.'
  );

const requestSchema = z.object({
  homeServer: homeServerSchema,
  email: z.email('Enter a valid email.'),
});

const resetSchema = z
  .object({
    verificationCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
    password: z.string().min(8, 'At least 8 characters.'),
    confirmPassword: z.string().min(1, 'Confirm your password.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: "Passwords don't match.",
  });

export default function ResetPassword() {
  const { query } = useAuthParams();
  const loginHref = `/login${query}` as Href;

  const [step, setStep] = useState<'request' | 'reset' | 'complete'>('request');
  const [email, setEmail] = useState('');
  const [requestLoading, setRequestLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [resetError, setResetError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const requestForm = useForm<z.infer<typeof requestSchema>>({
    resolver: zodResolver(requestSchema),
    defaultValues: { homeServer: 'novarum.me', email: '' },
  });

  const resetForm = useForm<z.infer<typeof resetSchema>>({
    resolver: zodResolver(resetSchema),
    mode: 'onChange',
    defaultValues: { verificationCode: '', password: '', confirmPassword: '' },
  });

  const submitRequest = requestForm.handleSubmit(async (data) => {
    setRequestLoading(true);
    setRequestError('');

    try {
      await anchor().setHomeServer(data.homeServer);
      const address = data.email.trim().toLowerCase();
      setEmail(address);
      const { error } = await anchor().client.auth['password-reset'].request.post({
        email: address,
      });

      if (error) {
        setRequestError(getErrorMessage(error.value, 'Could not send the reset code.'));
        return;
      }

      setStep('reset');
    } catch (error) {
      setRequestError(getErrorMessage(error, 'Could not send the reset code. Try again.'));
    } finally {
      setRequestLoading(false);
    }
  });

  const submitReset = resetForm.handleSubmit(async (data) => {
    setResetLoading(true);
    setResetError('');

    try {
      const { error } = await anchor().client.auth['reset-password'].post({
        email,
        newPassword: data.password,
        verificationCode: Number(data.verificationCode),
      });

      if (error) {
        setResetError(getErrorMessage(error.value, 'Could not reset your password.'));
        return;
      }

      setStep('complete');
    } catch (error) {
      setResetError(getErrorMessage(error, 'Could not reset your password. Try again.'));
    } finally {
      setResetLoading(false);
    }
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

  const title = {
    request: 'Reset your password',
    reset: 'Check your inbox',
    complete: 'Password updated!',
  }[step];
  const description =
    step === 'request' ? (
      'Enter your account email and a 6-digit code will be sent to you.'
    ) : step === 'reset' ? (
      <>
        Enter the code sent to <Text className="text-sm">{email}</Text>. It expires in 10 minutes.
      </>
    ) : undefined;

  return (
    <AuthCard
      title={title}
      description={description}
      centered={step === 'request'}
      footer={
        step !== 'complete' && (
          <>
            <Text className="text-xs text-muted-foreground">Remember your password?</Text>
            <TextLink onPress={() => router.replace(loginHref)}>Sign in</TextLink>
          </>
        )
      }
    >
      {step === 'request' ? (
        <View className="gap-4">
          <AuthField
            control={requestForm.control}
            name="homeServer"
            label="Home server"
            icon={Server}
            placeholder="novarum.me"
            autoComplete="url"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => requestForm.setFocus('email')}
          />
          <AuthField
            control={requestForm.control}
            name="email"
            label="Email"
            icon={Mail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={submitRequest}
          />

          <Button size="lg" className="w-full" disabled={requestLoading} onPress={submitRequest}>
            <ButtonLabel
              loading={requestLoading}
              loadingText="Sending code..."
              text="Send reset code"
            />
          </Button>

          {requestError ? (
            <Text className="text-sm text-destructive" accessibilityRole="alert">
              {requestError}
            </Text>
          ) : null}
        </View>
      ) : step === 'reset' ? (
        <View className="gap-4">
          <AuthField
            control={resetForm.control}
            name="verificationCode"
            label="Verification code"
            icon={KeyRound}
            className="font-mono tracking-widest"
            placeholder="000000"
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={() => resetForm.setFocus('password')}
          />
          <AuthField
            control={resetForm.control}
            name="password"
            label="New password"
            icon={Lock}
            right={toggle}
            secureTextEntry={!showPassword}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            textContentType="newPassword"
            autoCapitalize="none"
            returnKeyType="next"
            onSubmitEditing={() => resetForm.setFocus('confirmPassword')}
          />
          <AuthField
            control={resetForm.control}
            name="confirmPassword"
            label="Confirm new password"
            icon={Lock}
            secureTextEntry={!showPassword}
            placeholder="Re-enter your password"
            autoComplete="new-password"
            textContentType="newPassword"
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={submitReset}
          />

          <View className="flex-row gap-2">
            <Button
              variant="ghost"
              size="lg"
              className="w-12 px-0"
              accessibilityLabel="Back"
              onPress={() => {
                setStep('request');
                setResetError('');
              }}
            >
              <Icon as={ArrowLeft} size={16} />
            </Button>
            <Button
              size="lg"
              className="min-w-0 flex-1"
              disabled={resetLoading}
              onPress={submitReset}
            >
              <ButtonLabel
                loading={resetLoading}
                loadingText="Updating password..."
                text="Update password"
              />
            </Button>
          </View>

          {resetError ? (
            <Text className="text-sm text-destructive" accessibilityRole="alert">
              {resetError}
            </Text>
          ) : null}
        </View>
      ) : (
        <View className="gap-5">
          <View
            className="flex-row items-start gap-3 border border-emerald-400/20 bg-emerald-400/5 p-3"
            accessibilityRole="alert"
          >
            <Icon as={CircleCheck} size={16} className="mt-0.5 text-emerald-300" />
            <Text className="flex-1 text-sm text-emerald-300">
              You can now sign in with your new password.
            </Text>
          </View>
          <Button size="lg" className="w-full" onPress={() => router.replace(loginHref)}>
            <Text>Return to sign in</Text>
            <Icon as={ArrowRight} size={16} className="text-primary-foreground" />
          </Button>
        </View>
      )}
    </AuthCard>
  );
}
