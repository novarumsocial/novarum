<script lang="ts">
  import { page } from '$app/state';
  import { anchor } from '$lib/anchor.svelte';
  import ConstellationBackground from '$lib/components/constellation-background.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Form from '$lib/components/ui/form/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { safeRedirect } from '$lib/safeRedirect';
  import { getErrorMessage } from '$lib/session.svelte';
  import {
    ArrowLeft,
    ArrowRight,
    CircleCheck,
    Eye,
    EyeOff,
    KeyRound,
    LoaderCircle,
    Lock,
    Mail,
    Server,
  } from '@lucide/svelte';
  import { defaults, superForm } from 'sveltekit-superforms';
  import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
  import { z } from 'zod';
  import Logo from '$lib/assets/favicon.svg';

  const homeServerSchema = z
    .string()
    .trim()
    .min(1, 'Pick a home server.')
    .regex(
      /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?$/,
      'Enter a valid server address.'
    );

  const requestSchema = z.object({
    homeServer: homeServerSchema.default('novarum.me'),
    email: z.email('Enter a valid email.').default(''),
  });

  const resetSchema = z
    .object({
      verificationCode: z
        .string()
        .regex(/^\d{6}$/, 'Enter the 6-digit code.')
        .default(''),
      password: z.string().min(8, 'At least 8 characters.').default(''),
      confirmPassword: z.string().min(1, 'Confirm your password.').default(''),
    })
    .refine((data) => data.password === data.confirmPassword, {
      path: ['confirmPassword'],
      message: "Passwords don't match.",
    });

  const redirectParam = page.url.searchParams.get('redirect');
  const loginHref = redirectParam
    ? `/login?redirect=${encodeURIComponent(safeRedirect(redirectParam))}`
    : '/login';

  let step = $state<'request' | 'reset' | 'complete'>('request');
  let email = $state('');
  let requestLoading = $state(false);
  let resetLoading = $state(false);
  let requestError = $state('');
  let resetError = $state('');
  let showPassword = $state(false);

  const requestForm = superForm(defaults(zod4(requestSchema)), {
    SPA: true,
    validators: zod4Client(requestSchema),
    validationMethod: 'onsubmit',
    multipleSubmits: 'prevent',
    resetForm: false,
    onSubmit() {
      requestLoading = true;
      requestError = '';
    },
    async onUpdate({ form }) {
      if (!form.valid) {
        requestLoading = false;
        return;
      }

      try {
        await anchor.setHomeServer(form.data.homeServer);
        email = form.data.email.trim().toLowerCase();
        const { error } = await anchor.client.auth['password-reset'].request.post({ email });

        if (error) {
          requestError = getErrorMessage(error.value, 'Could not send the reset code.');
          return;
        }

        step = 'reset';
      } catch (error) {
        requestError = getErrorMessage(error, 'Could not send the reset code. Try again.');
      } finally {
        requestLoading = false;
      }
    },
  });

  const resetForm = superForm(defaults(zod4(resetSchema)), {
    SPA: true,
    validators: zod4Client(resetSchema),
    validationMethod: 'oninput',
    multipleSubmits: 'prevent',
    resetForm: false,
    onSubmit() {
      resetLoading = true;
      resetError = '';
    },
    async onUpdate({ form }) {
      if (!form.valid) {
        resetLoading = false;
        return;
      }

      try {
        const { error } = await anchor.client.auth['reset-password'].post({
          email,
          newPassword: form.data.password,
          verificationCode: Number(form.data.verificationCode),
        });

        if (error) {
          resetError = getErrorMessage(error.value, 'Could not reset your password.');
          return;
        }

        step = 'complete';
      } catch (error) {
        resetError = getErrorMessage(error, 'Could not reset your password. Try again.');
      } finally {
        resetLoading = false;
      }
    },
  });

  const { form: requestData, enhance: enhanceRequest } = requestForm;
  const { form: resetData, enhance: enhanceReset } = resetForm;
</script>

<svelte:head>
  <title>novarum - reset password</title>
  <meta name="description" content="Reset your novarum account password" />
</svelte:head>

<div class="dark relative min-h-svh overflow-hidden bg-background">
  <ConstellationBackground class="absolute inset-0 h-full w-full" />

  <div
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(130,175,235,0.10),transparent_58%)]"
  ></div>
  <div
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.6)_100%)]"
  ></div>

  <div class="relative flex min-h-svh items-center justify-center p-4 py-10">
    <Card.Root
      class="w-full max-w-md border-white/10 bg-card/70 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur-xl"
    >
      <Card.Header class="space-y-3">
        <div class="flex items-center gap-2.5">
          <div class="flex size-9 items-center justify-center bg-primary text-primary-foreground">
            <img src={Logo} alt="novarum" class="absolute size-5" />
          </div>
          <span class="text-lg font-semibold tracking-tight">novarum</span>
        </div>

        {#if step === 'request'}
          <div class="space-y-1">
            <Card.Title class="text-xl">Reset your password</Card.Title>
            <Card.Description>
              Enter your account email and a 6-digit code will be sent to you.
            </Card.Description>
          </div>
        {:else if step === 'reset'}
          <div class="space-y-1">
            <Card.Title class="text-xl">Check your inbox</Card.Title>
            <Card.Description>
              Enter the code sent to <span class="text-foreground">{email}</span>. It expires in 10
              minutes.
            </Card.Description>
          </div>
        {:else}
          <div class="space-y-1">
            <Card.Title class="text-xl">Password updated!</Card.Title>
          </div>
        {/if}
      </Card.Header>

      <Card.Content>
        {#if step === 'request'}
          <form method="POST" class="space-y-4" use:enhanceRequest>
            <Form.Field form={requestForm} name="homeServer" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <Form.Label>Home server</Form.Label>
                  <div class="relative">
                    <Server
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      {...props}
                      bind:value={$requestData.homeServer}
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

            <Form.Field form={requestForm} name="email" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <Form.Label>Email</Form.Label>
                  <div class="relative">
                    <Mail
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      {...props}
                      type="email"
                      bind:value={$requestData.email}
                      placeholder="you@example.com"
                      class="pl-8"
                      autocomplete="email"
                    />
                  </div>
                {/snippet}
              </Form.Control>
              <Form.FieldErrors class="text-xs" />
            </Form.Field>

            <Form.Button class="w-full" size="lg" disabled={requestLoading}>
              {#if requestLoading}
                <LoaderCircle class="size-4 animate-spin" />
                <span>Sending code...</span>
              {:else}
                <span>Send reset code</span>
                <ArrowRight class="size-4" />
              {/if}
            </Form.Button>

            {#if requestError}
              <p class="text-sm text-destructive" role="alert">{requestError}</p>
            {/if}
          </form>
        {:else if step === 'reset'}
          <form method="POST" class="space-y-4" use:enhanceReset>
            <Form.Field form={resetForm} name="verificationCode" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <Form.Label>Verification code</Form.Label>
                  <div class="relative">
                    <KeyRound
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      {...props}
                      bind:value={$resetData.verificationCode}
                      placeholder="000000"
                      class="pl-8 font-mono tracking-[0.3em]"
                      inputmode="numeric"
                      autocomplete="one-time-code"
                      maxlength={6}
                      autofocus
                    />
                  </div>
                {/snippet}
              </Form.Control>
              <Form.FieldErrors class="text-xs" />
            </Form.Field>

            <Form.Field form={resetForm} name="password" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <Form.Label>New password</Form.Label>
                  <div class="relative">
                    <Lock
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      {...props}
                      type={showPassword ? 'text' : 'password'}
                      bind:value={$resetData.password}
                      placeholder="At least 8 characters"
                      class="px-8"
                      autocomplete="new-password"
                    />
                    <button
                      type="button"
                      onclick={() => (showPassword = !showPassword)}
                      class="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      tabindex={-1}
                    >
                      {#if showPassword}
                        <EyeOff class="size-4" />
                      {:else}
                        <Eye class="size-4" />
                      {/if}
                    </button>
                  </div>
                {/snippet}
              </Form.Control>
              <Form.FieldErrors class="text-xs" />
            </Form.Field>

            <Form.Field form={resetForm} name="confirmPassword" class="space-y-1.5">
              <Form.Control>
                {#snippet children({ props })}
                  <Form.Label>Confirm new password</Form.Label>
                  <div class="relative">
                    <Lock
                      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      {...props}
                      type={showPassword ? 'text' : 'password'}
                      bind:value={$resetData.confirmPassword}
                      placeholder="Re-enter your password"
                      class="pl-8"
                      autocomplete="new-password"
                    />
                  </div>
                {/snippet}
              </Form.Control>
              <Form.FieldErrors class="text-xs" />
            </Form.Field>

            <div class="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                onclick={() => {
                  step = 'request';
                  resetError = '';
                }}
              >
                <ArrowLeft class="size-4" />
              </Button>

              <Form.Button size="lg" class="min-w-0 flex-1" disabled={resetLoading}>
                {#if resetLoading}
                  <LoaderCircle class="size-4 animate-spin" />
                  <span>Updating password...</span>
                {:else}
                  <span>Update password</span>
                  <ArrowRight class="size-4" />
                {/if}
              </Form.Button>
            </div>

            {#if resetError}
              <p class="text-sm text-destructive" role="alert">{resetError}</p>
            {/if}
          </form>
        {:else}
          <div class="flex flex-col gap-5">
            <div
              class="flex items-start gap-3 border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm text-emerald-300"
              role="status"
            >
              <CircleCheck class="mt-0.5 size-4 shrink-0" />
              <p>You can now sign in with your new password.</p>
            </div>
            <Button href={loginHref} class="w-full" size="lg">
              Return to sign in
              <ArrowRight class="size-4" />
            </Button>
          </div>
        {/if}
      </Card.Content>

      {#if step !== 'complete'}
        <Card.Footer class="justify-center text-xs text-muted-foreground">
          <span>Remember your password?</span>
          <a
            href={loginHref}
            class="ml-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline"
            >Sign in</a
          >
        </Card.Footer>
      {/if}
    </Card.Root>
  </div>
</div>
