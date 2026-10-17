// Port of the "security" tab of apps/frontend/src/lib/components/settings-dialog.svelte
// Native difference: no QR code (you can't scan your own screen); the setup key is shown with Copy and an `otpauth://` link.
import * as Clipboard from 'expo-clipboard';
import {
  Check,
  Copy,
  ExternalLink,
  Mail,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Linking, View } from 'react-native';
import { z } from 'zod';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { SettingsRow } from '@/components/settings-row';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { anchor } from '@/lib/anchor';
import { getErrorMessage } from '@/lib/session';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react-native';

type MfaOption = 'EMAIL' | 'TOTP';

const totpCodeSchema = z
  .string()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');

// an icon tile + title + switch, shared by the email and authenticator rows
function MfaRow({
  icon,
  active,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  active: boolean;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <View className="flex-row items-center justify-between gap-4 px-4 py-3">
      <View className="min-w-0 flex-1 flex-row items-start gap-3">
        <View
          className={cn(
            'size-8 items-center justify-center',
            active ? 'bg-emerald-500/15' : 'bg-muted'
          )}
        >
          <Icon
            as={icon}
            size={16}
            className={active ? 'text-emerald-400' : 'text-muted-foreground'}
          />
        </View>
        <View className="min-w-0 flex-1">
          <Label>{title}</Label>
          <Text className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </Text>
        </View>
      </View>
      <View className="shrink-0 flex-row items-center gap-3">{children}</View>
    </View>
  );
}

export default function Security() {
  const showOnlineStatus = useSettings((s) => s.showOnlineStatus);
  const update = useSettings((s) => s.update);

  const [mfaOptions, setMfaOptions] = useState<MfaOption[]>([]);
  const [mfaLoaded, setMfaLoaded] = useState(false);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [emailMfaLoading, setEmailMfaLoading] = useState(false);
  const [totpState, setTotpState] = useState<'idle' | 'setup' | 'enabled' | 'error'>('idle');
  const [totpUri, setTotpUri] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpMfaLoading, setTotpMfaLoading] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [totpDeleteLoading, setTotpDeleteLoading] = useState(false);

  const withOption = (options: MfaOption[], option: MfaOption, enable: boolean) =>
    enable ? [...new Set([...options, option])] : options.filter((other) => other !== option);

  useEffect(() => {
    void loadMfaStatus();
    // only once, when the screen opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMfaStatus() {
    setMfaLoading(true);
    setMfaError(null);

    try {
      const result = await anchor().client.auth.mfa.get();
      if (result.error || !result.data) {
        setMfaError(getErrorMessage(result.error?.value, 'Could not load MFA settings.'));
        return;
      }

      setMfaOptions(result.data.mfaOptions);
      setMfaLoaded(true);
      if (result.data.mfaOptions.includes('TOTP')) setTotpState('enabled');
      else await loadTotpSetup();
    } catch (error) {
      setMfaError(getErrorMessage(error, 'Could not load MFA settings.'));
    } finally {
      setMfaLoading(false);
    }
  }

  async function toggleEmailMfa(enable: boolean) {
    setEmailMfaLoading(true);
    setMfaError(null);

    try {
      const result = await anchor().client.auth.mfa.email.toggle.post({ enable });
      if (result.error) {
        setMfaError(getErrorMessage(result.error.value, 'Could not update email MFA.'));
        return;
      }

      setMfaOptions((options) => withOption(options, 'EMAIL', enable));
    } catch (error) {
      setMfaError(getErrorMessage(error, 'Could not update email MFA.'));
    } finally {
      setEmailMfaLoading(false);
    }
  }

  async function toggleTotpMfa(enable: boolean) {
    setTotpMfaLoading(true);
    setMfaError(null);

    try {
      const result = await anchor().client.auth.mfa.totp.toggle.post({ enable });
      if (result.error) {
        setMfaError(getErrorMessage(result.error.value, 'Could not update authenticator MFA.'));
        return;
      }

      setMfaOptions((options) => withOption(options, 'TOTP', enable));
    } catch (error) {
      setMfaError(getErrorMessage(error, 'Could not update authenticator MFA.'));
    } finally {
      setTotpMfaLoading(false);
    }
  }

  async function loadTotpSetup() {
    setTotpLoading(true);
    setTotpError(null);

    try {
      const result = await anchor().client.auth.mfa.totp.qr.get();
      if (result.error) {
        const message = getErrorMessage(result.error.value, 'Could not load MFA settings.');
        if (result.response.status === 400 && message.includes('already enabled')) {
          setTotpState('enabled');
          return;
        }
        setTotpError(message);
        setTotpState('error');
        return;
      }

      if (!result.data) {
        setTotpError('The server returned an invalid MFA setup.');
        setTotpState('error');
        return;
      }

      setTotpUri(result.data.uri);
      setTotpSecret(result.data.secret);
      setTotpState('setup');
    } catch (error) {
      setTotpError(getErrorMessage(error, 'Could not load MFA settings.'));
      setTotpState('error');
    } finally {
      setTotpLoading(false);
    }
  }

  async function enableTotp() {
    const code = totpCodeSchema.safeParse(totpCode);
    if (!code.success) {
      setTotpError(code.error.issues[0]?.message ?? null);
      return;
    }

    setTotpLoading(true);
    setTotpError(null);

    try {
      const result = await anchor().client.auth.mfa.totp.enable.post({
        secret: totpSecret,
        code: code.data,
      });
      if (result.error) {
        setTotpError(getErrorMessage(result.error.value, 'Could not enable MFA.'));
        return;
      }

      setTotpState('enabled');
      setMfaOptions((options) => withOption(options, 'TOTP', true));
      setTotpUri('');
      setTotpSecret('');
      setTotpCode('');
    } catch (error) {
      setTotpError(getErrorMessage(error, 'Could not enable MFA.'));
    } finally {
      setTotpLoading(false);
    }
  }

  async function copyTotpSecret() {
    try {
      await Clipboard.setStringAsync(totpSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 1500);
    } catch {
      setTotpError('Could not copy the setup key.');
    }
  }

  async function openAuthenticator() {
    try {
      await Linking.openURL(totpUri);
    } catch {
      setTotpError('No authenticator app found. Copy the setup key instead.');
    }
  }

  async function deleteTotp() {
    setTotpDeleteLoading(true);
    setMfaError(null);

    try {
      const result = await anchor().client.auth.mfa.totp.delete();
      if (result.error) {
        setMfaError(getErrorMessage(result.error.value, 'Could not remove authenticator MFA.'));
        return;
      }

      setMfaOptions((options) => withOption(options, 'TOTP', false));
      setTotpState('idle');
      await loadTotpSetup();
    } catch (error) {
      setMfaError(getErrorMessage(error, 'Could not remove authenticator MFA.'));
    } finally {
      setTotpDeleteLoading(false);
    }
  }

  // the web asks twice with a timed button; a phone asks with an alert
  const requestDeleteTotp = () =>
    Alert.alert('Remove authenticator app?', 'You will need to set it up again to use it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void deleteTotp() },
    ]);

  return (
    <SettingsPage description="Protect your account and choose what others can see.">
      <SettingsGroup title="Privacy">
        <SettingsRow title="Show online status" description="Let people see when you're online.">
          <Switch
            value={showOnlineStatus}
            onValueChange={(value) => update({ showOnlineStatus: value })}
          />
        </SettingsRow>
      </SettingsGroup>

      {mfaLoading && !mfaLoaded ? (
        <View className="flex-row items-center gap-2">
          <Spinner />
          <Text className="text-xs text-muted-foreground">Checking MFA status...</Text>
        </View>
      ) : !mfaLoaded ? (
        <View className="gap-2">
          <Text className="text-sm font-medium">MFA settings are unavailable</Text>
          <Text className="text-xs text-destructive">
            {mfaError ?? 'Could not load MFA settings.'}
          </Text>
          <Button variant="outline" size="sm" className="self-start" onPress={loadMfaStatus}>
            <Text>Try again</Text>
          </Button>
        </View>
      ) : (
        <SettingsGroup
          title="Two-step verification"
          description="Ask for a second code when you sign in."
        >
          <MfaRow
            icon={Mail}
            active={mfaOptions.includes('EMAIL')}
            title="Email codes"
            description="A one-time code sent to your account email."
          >
            <Switch
              value={mfaOptions.includes('EMAIL')}
              disabled={emailMfaLoading}
              accessibilityLabel="Enable email MFA"
              onValueChange={toggleEmailMfa}
            />
          </MfaRow>

          {totpLoading && totpState === 'idle' ? (
            <View className="min-h-20 flex-row items-center justify-center gap-2 px-4 py-4">
              <Spinner />
              <Text className="text-xs text-muted-foreground">
                Preparing authenticator setup...
              </Text>
            </View>
          ) : totpState === 'enabled' ? (
            <MfaRow
              icon={ShieldCheck}
              active={mfaOptions.includes('TOTP')}
              title="Authenticator app"
              description="One-time codes from your authenticator app."
            >
              <Button
                variant="outline"
                size="icon"
                className="size-9"
                accessibilityLabel="Remove authenticator app"
                disabled={totpMfaLoading || totpDeleteLoading}
                onPress={requestDeleteTotp}
              >
                {totpDeleteLoading ? <Spinner /> : <Icon as={Trash2} size={14} />}
              </Button>
              <Switch
                value={mfaOptions.includes('TOTP')}
                disabled={totpMfaLoading || totpDeleteLoading}
                accessibilityLabel="Enable authenticator MFA"
                onValueChange={toggleTotpMfa}
              />
            </MfaRow>
          ) : totpState === 'setup' ? (
            <View className="gap-4 px-4 py-4">
              <View className="flex-row items-center gap-2">
                <Icon as={Smartphone} size={16} />
                <Text className="text-sm font-medium">Set up an authenticator app</Text>
              </View>

              <View className="gap-2">
                <Text className="text-xs font-medium">Setup key</Text>
                <Text className="text-[11px] text-muted-foreground">
                  Add it to your authenticator app. Keep it private.
                </Text>
                <View className="flex-row items-stretch border border-border bg-muted/40">
                  <Text selectable className="min-w-0 flex-1 px-2.5 py-2 font-mono text-xs">
                    {totpSecret}
                  </Text>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="border-l border-border"
                    accessibilityLabel="Copy setup key"
                    onPress={copyTotpSecret}
                  >
                    <Icon as={secretCopied ? Check : Copy} size={14} />
                  </Button>
                </View>
                <Button variant="outline" onPress={openAuthenticator}>
                  <Icon as={ExternalLink} size={16} />
                  <Text>Open in authenticator app</Text>
                </Button>
              </View>

              <View className="gap-1.5">
                <Label>Verification code</Label>
                <View className="flex-row gap-2">
                  <Input
                    value={totpCode}
                    onChangeText={(text) => setTotpCode(text.replace(/\D/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    returnKeyType="done"
                    onSubmitEditing={enableTotp}
                    className={cn(
                      'flex-1 font-mono tracking-widest',
                      totpError && 'border-destructive'
                    )}
                  />
                  <Button disabled={totpLoading} onPress={enableTotp}>
                    {totpLoading && <Spinner />}
                    <Text>Enable MFA</Text>
                  </Button>
                </View>
                <Text className="min-h-4 text-xs text-destructive" accessibilityLiveRegion="polite">
                  {totpError ?? ''}
                </Text>
              </View>
            </View>
          ) : (
            <View className="flex-row items-center justify-between gap-4 px-4 py-3">
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-medium">Authenticator app</Text>
                <Text className="mt-0.5 text-xs text-destructive">
                  {totpError ?? 'Could not prepare authenticator setup.'}
                </Text>
              </View>
              <Button variant="outline" size="sm" onPress={loadTotpSetup}>
                <Text>Try again</Text>
              </Button>
            </View>
          )}

          {mfaError ? (
            <Text className="px-4 py-2 text-xs text-destructive" accessibilityLiveRegion="polite">
              {mfaError}
            </Text>
          ) : null}
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
