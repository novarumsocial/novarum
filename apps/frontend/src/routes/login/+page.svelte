<script lang="ts">
  import { z } from 'zod';
  import { defaults, superForm } from 'sveltekit-superforms';
  import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { useSession, type MfaMethod } from '$lib/session.svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Form from '$lib/components/ui/form/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as InputOTP from '$lib/components/ui/input-otp/index.js';
  import Logo from '$lib/assets/favicon.svg';
  import {
    Server,
    AtSign,
    Lock,
    ArrowRight,
    ArrowLeft,
    LoaderCircle,
    Mail,
    Smartphone,
    LogIn,
  } from '@lucide/svelte';
  import ConstellationBackground from '$lib/components/constellation-background.svelte';
  import { safeRedirect } from '$lib/safeRedirect';

  const loginSchema = z.object({
    homeServer: z
      .string()
      .trim()
      .min(1, 'Pick a home server.')
      .regex(
        /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?$/,
        'Enter a valid server address.'
      )
      .default('novarum.me'),
    username: z
      .string()
      .trim()
      .min(2, 'At least 2 characters.')
      .max(32, 'At most 32 characters.')
      .regex(/^[a-zA-Z0-9._]+$/, 'Letters, numbers, dots, underscores only.')
      .default(''),
    password: z.string().min(1, 'Enter your password.').default(''),
  });

  let loading = $state(false);
  let submitError = $state('');
  let mfaChallenge = $state('');
  let mfaMethods = $state<MfaMethod[]>([]);
  let mfaMethod = $state<MfaMethod>('EMAIL');
  let mfaCode = $state('');
  let emailSent = $state(false);
  let sendingEmail = $state(false);
  let showLoginOptions = $state(false);
  const session = useSession();
  const redirectParam = page.url.searchParams.get('redirect');

  onMount(() => {
    void session.refresh().then(async (user) => {
      if (user) {
        await goto(safeRedirect(redirectParam));
      }
    });
  });

  const form = superForm(defaults(zod4(loginSchema)), {
    SPA: true,
    validators: zod4Client(loginSchema),
    validationMethod: 'onsubmit',
    multipleSubmits: 'prevent',
    clearOnSubmit: 'none',
    resetForm: false,
    onSubmit() {
      loading = true;
      submitError = '';
    },
    async onUpdate({ form: updatedForm }) {
      if (!updatedForm.valid) {
        loading = false;
        return;
      }

      const result = await session.login({
        homeServer: updatedForm.data.homeServer,
        username: updatedForm.data.username,
        password: updatedForm.data.password,
      });

      if (!result.ok) {
        submitError = result.error;
        loading = false;
        return;
      }

      if ('mfa' in result) {
        mfaChallenge = result.mfa.challenge;
        mfaMethods = result.mfa.methods;
        mfaMethod = result.mfa.methods.includes('TOTP') ? 'TOTP' : 'EMAIL';
        loading = false;
        return;
      }

      await goto(safeRedirect(redirectParam));
    },
  });

  const { form: formData, enhance } = form;

  async function verifyMfa(event: SubmitEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(mfaCode)) {
      submitError = 'Enter the six-digit verification code.';
      return;
    }

    loading = true;
    submitError = '';
    const result = await session.completeMfa(mfaChallenge, mfaMethod, mfaCode);
    if (!result.ok) {
      submitError = result.error;
      loading = false;
      return;
    }

    await goto(safeRedirect(redirectParam));
  }

  async function sendEmailCode() {
    sendingEmail = true;
    submitError = '';
    const result = await session.sendMfaEmail(mfaChallenge);
    sendingEmail = false;

    if (!result.ok) {
      submitError = result.error;
      return;
    }

    emailSent = true;
    mfaCode = '';
  }

  function selectMfaMethod(method: MfaMethod) {
    mfaMethod = method;
    mfaCode = '';
    submitError = '';
    showLoginOptions = false;
  }

  function restartLogin() {
    mfaChallenge = '';
    mfaMethods = [];
    mfaCode = '';
    emailSent = false;
    showLoginOptions = false;
    submitError = '';
  }
</script>

<svelte:head>
  <title>novarum - sign in</title>
  <meta name="description" content="Sign in to your novarum account" />
</svelte:head>

<div class="dark relative min-h-svh overflow-hidden bg-background">
  <ConstellationBackground class="absolute inset-0 h-full w-full" />

  <div
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(130,175,235,0.10),transparent_58%)]"
  ></div>
  <div
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.6)_100%)]"
  ></div>

  <div class="absolute top-6 left-6 z-20 flex items-center gap-2.5 select-none">
    <div class="flex size-9 items-center justify-center bg-primary text-primary-foreground">
      <img src={Logo} alt="novarum" class="absolute size-5" />
    </div>
    <span class="text-lg font-semibold tracking-tight">novarum</span>
  </div>

  <div class="relative flex min-h-svh items-center justify-center p-4">
    <Card.Root
      class="w-full max-w-md border-white/10 bg-card/70 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl"
    >
      <Card.Header class="space-y-3">
        <div class="space-y-1 mt-1.5">
          <Card.Title class="text-xl text-center">
            {mfaChallenge ? 'Verify it’s you' : 'Welcome back'}
          </Card.Title>
          <Card.Description class="text-center">
            {mfaChallenge
              ? mfaMethod === 'EMAIL'
                ? emailSent
                  ? 'Enter the code sent to the email on your account.'
                  : 'Get a one-time code sent to the email on your account.'
                : 'Enter the current code from your authenticator app.'
              : 'Sign in to your home server to continue.'}
          </Card.Description>
        </div>
      </Card.Header>

      <Card.Content>
        {#if mfaChallenge}
          <form class="space-y-5" onsubmit={verifyMfa}>
            {#if showLoginOptions}
              <div class="space-y-2 rounded-lg border border-white/10 bg-background/35 p-2">
                <p class="px-2 pt-1 text-xs font-medium text-muted-foreground">
                  Choose how to verify
                </p>
                {#if mfaMethods.includes('TOTP')}
                  <Button
                    type="button"
                    variant="ghost"
                    class="h-auto w-full justify-start gap-3 px-3 py-2.5"
                    onclick={() => selectMfaMethod('TOTP')}
                  >
                    <Smartphone class="size-4" />
                    <span class="text-left">
                      <span class="block text-sm">Authenticator app</span>
                      <span class="block text-xs font-normal text-muted-foreground"
                        >Use a rotating code</span
                      >
                    </span>
                  </Button>
                {/if}
                {#if mfaMethods.includes('EMAIL')}
                  <Button
                    type="button"
                    variant="ghost"
                    class="h-auto w-full justify-start gap-3 px-3 py-2.5"
                    onclick={() => selectMfaMethod('EMAIL')}
                  >
                    <Mail class="size-4" />
                    <span class="text-left">
                      <span class="block text-sm">Email code</span>
                      <span class="block text-xs font-normal text-muted-foreground"
                        >Send a one-time code</span
                      >
                    </span>
                  </Button>
                {/if}
              </div>
            {:else if mfaMethod === 'EMAIL' && !emailSent}
              <div
                class="space-y-3 rounded-lg border border-white/10 bg-background/35 p-4 text-center"
              >
                <Mail class="mx-auto size-6 text-primary" />
                <p class="text-sm text-muted-foreground">
                  Ready? Click that fancy button below to send a one-time code to the email on your
                  account.
                </p>
                <Button
                  type="button"
                  class="w-full"
                  disabled={sendingEmail}
                  onclick={sendEmailCode}
                >
                  {#if sendingEmail}
                    <LoaderCircle class="size-4 animate-spin" />
                    Sending…
                  {:else}
                    <Mail class="size-4" />
                    Send email code
                  {/if}
                </Button>
              </div>
            {:else}
              <div class="space-y-3">
                <span class="block text-center text-sm font-medium">Verification code</span>
                <InputOTP.Root
                  maxlength={6}
                  onComplete={() => {
                    if (mfaCode.length === 6) {
                      verifyMfa(new SubmitEvent('submit'));
                    }
                  }}
                  bind:value={mfaCode}
                  disabled={loading}
                  class="justify-center"
                  aria-label="Six-digit verification code"
                >
                  {#snippet children({ cells })}
                    <InputOTP.Group class="gap-2">
                      {#each cells as cell (cell)}
                        <InputOTP.Slot
                          {cell}
                          class="size-11 rounded-md border bg-background/60 font-mono text-base first:rounded-md last:rounded-md"
                        />
                      {/each}
                    </InputOTP.Group>
                  {/snippet}
                </InputOTP.Root>
              </div>

              <Button
                type="submit"
                class="w-full"
                size="lg"
                disabled={loading || mfaCode.length !== 6}
              >
                {#if loading}
                  <LoaderCircle class="size-4 animate-spin" />
                  <span>Verifying…</span>
                {:else}
                  <span>Verify and sign in</span>
                  <ArrowRight class="size-4" />
                {/if}
              </Button>

              {#if mfaMethod === 'EMAIL'}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="w-full text-muted-foreground"
                  disabled={sendingEmail}
                  onclick={sendEmailCode}
                >
                  {sendingEmail ? 'Sending…' : 'Send a new code'}
                </Button>
              {/if}
            {/if}

            {#if mfaMethods.length > 1 && !showLoginOptions}
              <Button
                type="button"
                variant="outline"
                class="w-full"
                onclick={() => (showLoginOptions = true)}
              >
                Try another way
              </Button>
            {/if}

            {#if submitError}
              <p class="text-center text-sm text-destructive" aria-live="polite">{submitError}</p>
            {/if}
          </form>
        {:else}
          <form method="POST" class="space-y-4" use:enhance>
            <Form.Field {form} name="homeServer" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <Form.Label>Home server</Form.Label>
                  <div class="relative">
                    <Server
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />

                    <!-- TODO: when possible, instead of placeholder="novarum.me" remember last logged in instance from localstorage -->
                    <Input
                      {...props}
                      bind:value={$formData.homeServer}
                      name="homeServer"
                      placeholder="novarum.me"
                      class="pl-8"
                      autocomplete="url"
                      spellcheck="false"
                    />
                  </div>
                {/snippet}
              </Form.Control>
              <Form.FieldErrors class="text-xs" />
            </Form.Field>

            <Form.Field {form} name="username" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <Form.Label>Username</Form.Label>
                  <div class="relative">
                    <AtSign
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      {...props}
                      bind:value={$formData.username}
                      name="username"
                      placeholder="alice"
                      class="pl-8"
                      autocomplete="username"
                      spellcheck="false"
                      autocapitalize="none"
                    />
                  </div>
                {/snippet}
              </Form.Control>
              <Form.FieldErrors class="text-xs" />
            </Form.Field>

            <Form.Field {form} name="password" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <div class="flex items-center justify-between">
                    <Form.Label>Password</Form.Label>
                    <a
                      href={redirectParam
                        ? `/reset-password?redirect=${encodeURIComponent(safeRedirect(redirectParam))}`
                        : '/reset-password'}
                      class="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      tabindex="-1"
                    >
                      Forgot password?
                    </a>
                  </div>
                  <div class="relative">
                    <Lock
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      {...props}
                      type="password"
                      bind:value={$formData.password}
                      placeholder="••••••••"
                      class="pl-8"
                      autocomplete="current-password"
                      name="password"
                    />
                  </div>
                {/snippet}
              </Form.Control>
              <Form.FieldErrors class="text-xs" />
            </Form.Field>

            <Form.Button class="w-full" size="lg" disabled={loading}>
              {#if loading}
                <LoaderCircle class="size-4 animate-spin" />
                <span>Signing in…</span>
              {:else}
                <span>Sign in</span>
                <LogIn class="size-4" />
              {/if}
            </Form.Button>

            {#if submitError}
              <p class="text-sm text-destructive">{submitError}</p>
            {/if}
          </form>
        {/if}

        <!--<div class="my-5 flex items-center gap-3">
					<Separator class="flex-1" />
					<span class="text-xs text-muted-foreground">or</span>
					<Separator class="flex-1" />
				</div>

				<Button type="button" variant="outline" class="w-full" size="lg">
					Continue with SSO
				</Button>-->
      </Card.Content>

      <Card.Footer class="justify-center text-xs text-muted-foreground">
        {#if mfaChallenge}
          <button
            type="button"
            class="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
            onclick={restartLogin}
          >
            <ArrowLeft class="size-3.5" />
            Back to sign in
          </button>
        {:else}
          <span>Don't have an account?</span>
          <a
            href={`/register?redirect=${safeRedirect(redirectParam)}`}
            class="ml-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline"
            >Register</a
          >
        {/if}
      </Card.Footer>
    </Card.Root>
  </div>
</div>
