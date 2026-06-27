<script lang="ts">
	import { z } from "zod";
	import { defaults, superForm } from "sveltekit-superforms";
	import { zod4, zod4Client } from "sveltekit-superforms/adapters";
	import { goto } from "$app/navigation";
	import { anchor } from "$lib/anchor.svelte";
	import * as Card from "$lib/components/ui/card/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Form from "$lib/components/ui/form/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";
	import {
		MessagesSquare,
		Server,
		AtSign,
		User,
		Mail,
		Lock,
		Eye,
		EyeOff,
		ArrowRight,
		LoaderCircle,
		CircleCheck
	} from "@lucide/svelte";
	import ConstellationBackground from "$lib/components/constellation-background.svelte";

	const registerSchema = z
		.object({
			username: z
				.string()
				.trim()
				.min(2, "At least 2 characters.")
				.max(32, "At most 32 characters.")
				.regex(/^[a-zA-Z0-9._]+$/, "Letters, numbers, dots, underscores only.")
				.default(""),
			homeserver: z
				.string()
				.trim()
				.min(1, "Pick a home server.")
				.regex(
					/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?$/,
					"Enter a valid server address."
				)
				.default("novarum.social"),
			displayName: z.string().trim().max(64, "At most 64 characters.").default(""),
			email: z.email("Enter a valid email.").default(""),
			password: z.string().min(8, "At least 8 characters.").default(""),
			confirmPassword: z.string().min(1, "Confirm your password.").default("")
		})
		.refine((data) => data.password === data.confirmPassword, {
			path: ["confirmPassword"],
			message: "Passwords don't match."
		});

	let loading = $state(false);
	let showPassword = $state(false);
	let submitError = $state("");

	function getErrorMessage(error: unknown) {
		if (error && typeof error === "object" && "error" in error) {
			return String(error.error);
		}

		return "Could not create your account.";
	}

	function cookieWarning() {
		return "Account created, but your browser did not keep the session cookie. Enable third-party cookies for this site, then sign in.";
	}

	const form = superForm(defaults(zod4(registerSchema)), {
		SPA: true,
		validators: zod4Client(registerSchema),
		validationMethod: "oninput",
		multipleSubmits: "prevent",
		onSubmit() {
			loading = true;
			submitError = "";
		},
		async onUpdate({ form: updatedForm }) {
			if (!updatedForm.valid) {
				loading = false;
				return;
			}

			try {
				await anchor.setHomeServer(updatedForm.data.homeserver);
			} catch {
				submitError = "Could not discover that home server.";
				loading = false;
				return;
			}

			const { error } = await anchor.client.auth.signup.post({
				username: updatedForm.data.username,
				displayName: updatedForm.data.displayName,
				email: updatedForm.data.email,
				password: updatedForm.data.password
			});

			if (error) {
				submitError = getErrorMessage(error.value);
				loading = false;
				return;
			}

			const me = await anchor.client.auth.me.get();
			if (!me.data?.user) {
				submitError = cookieWarning();
				loading = false;
				return;
			}

			await goto("/guilds");
		}
	});

	const { form: formData, enhance } = form;
	let handle = $derived(`@${$formData.username || "username"}@${$formData.homeserver || "server"}`);
</script>

<svelte:head>
	<title>novarum - register</title>
	<meta name="description" content="Create your novarum account" />
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
					<div
						class="flex size-9 items-center justify-center bg-primary text-primary-foreground"
					>
						<MessagesSquare class="size-5" />
					</div>
					<span class="text-lg font-semibold tracking-tight">novarum</span>
				</div>
				<div class="space-y-1">
					<Card.Title class="text-xl">Create your account</Card.Title>
					<Card.Description>
						Pick a home server and username - your handle works across the federation.
					</Card.Description>
				</div>
			</Card.Header>

			<Card.Content>
				<form method="POST" class="space-y-4" use:enhance>
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

						<Form.Field {form} name="homeserver" class="space-y-1.5">
							<Form.Control>
								{#snippet children({ props })}
									<Form.Label>Home server</Form.Label>
									<div class="relative">
										<Server
											class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
										/>
										<Input
											{...props}
											bind:value={$formData.homeserver}
											placeholder="novarum.social"
											class="pl-8"
											autocomplete="url"
											spellcheck="false"
										/>
									</div>
								{/snippet}
							</Form.Control>
							<Form.FieldErrors class="text-xs" />
						</Form.Field>
					</div>

					<div class="rounded-none border border-white/10 bg-white/[0.03] px-3 py-2">
						<p class="text-xs text-muted-foreground">Your handle</p>
						<p class="break-all font-mono text-sm tracking-tight text-foreground">
							{handle}
						</p>
					</div>

					<Form.Field {form} name="displayName" class="space-y-1.5">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>
									Display name <span class="text-muted-foreground">(optional)</span>
								</Form.Label>
								<div class="relative">
									<User
										class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									/>
									<Input
										{...props}
										bind:value={$formData.displayName}
										placeholder="Alice"
										class="pl-8"
										autocomplete="nickname"
										maxlength={64}
									/>
								</div>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors class="text-xs" />
					</Form.Field>

					<Form.Field {form} name="email" class="space-y-1.5">
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
										bind:value={$formData.email}
										placeholder="you@example.com"
										class="pl-8"
										autocomplete="email"
									/>
								</div>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors class="text-xs" />
					</Form.Field>

					<Form.Field {form} name="password" class="space-y-1.5">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>Password</Form.Label>
								<div class="relative">
									<Lock
										class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									/>
									<Input
										{...props}
										type={showPassword ? "text" : "password"}
										bind:value={$formData.password}
										placeholder="At least 8 characters"
										class="pl-8 pr-8"
										autocomplete="new-password"
									/>
									<button
										type="button"
										onclick={() => (showPassword = !showPassword)}
										class="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
										aria-label={showPassword ? "Hide password" : "Show password"}
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
						{#if $formData.password.length >= 8}
							<p class="flex items-center gap-1 text-xs text-emerald-400">
								<CircleCheck class="size-3" />Looks good
							</p>
						{/if}
					</Form.Field>

					<Form.Field {form} name="confirmPassword" class="space-y-1.5">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>Confirm password</Form.Label>
								<div class="relative">
									<Lock
										class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									/>
									<Input
										{...props}
										type={showPassword ? "text" : "password"}
										bind:value={$formData.confirmPassword}
										placeholder="Re-enter your password"
										class="pl-8"
										autocomplete="new-password"
									/>
								</div>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors class="text-xs" />
						{#if $formData.confirmPassword && $formData.confirmPassword === $formData.password}
							<p class="flex items-center gap-1 text-xs text-emerald-400">
								<CircleCheck class="size-3" />Matches
							</p>
						{/if}
					</Form.Field>

					<Form.Button class="w-full" size="lg" disabled={loading}>
						{#if loading}
							<LoaderCircle class="size-4 animate-spin" />
							<span>Creating account…</span>
						{:else}
							<span>Create account</span>
							<ArrowRight class="size-4" />
						{/if}
					</Form.Button>

					{#if submitError}
						<p class="text-sm text-destructive">{submitError}</p>
					{/if}
				</form>

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
				<span>Already have an account?</span>
				<a
					href="/login"
					class="ml-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline"
				>Sign in</a
				>
			</Card.Footer>
		</Card.Root>
	</div>
</div>
