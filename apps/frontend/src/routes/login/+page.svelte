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
		Lock,
		ArrowRight,
		LoaderCircle
	} from "@lucide/svelte";
	import ConstellationBackground from "$lib/components/constellation-background.svelte";

	const loginSchema = z.object({
		homeServer: z
			.string()
			.trim()
			.min(1, "Pick a home server.")
			.regex(
				/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(:\d{1,5})?$/,
				"Enter a valid server address."
			)
			.default("novarum.social"),
		username: z
			.string()
			.trim()
			.min(2, "At least 2 characters.")
			.max(32, "At most 32 characters.")
			.regex(/^[a-zA-Z0-9._]+$/, "Letters, numbers, dots, underscores only.")
			.default(""),
		password: z.string().min(1, "Enter your password.").default("")
	});

	let loading = $state(false);
	let submitError = $state("");

	function getErrorMessage(error: unknown) {
		if (error && typeof error === "object" && "error" in error) {
			return String(error.error);
		}

		return "Could not sign you in.";
	}

	const form = superForm(defaults(zod4(loginSchema)), {
		SPA: true,
		validators: zod4Client(loginSchema),
		validationMethod: "onsubmit",
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

			anchor.setHomeServer(updatedForm.data.homeServer);
			const { error } = await anchor.client.auth.login.post({
				username: updatedForm.data.username,
				homeserver: updatedForm.data.homeServer,
				password: updatedForm.data.password
			});

			if (error) {
				submitError = getErrorMessage(error.value);
				loading = false;
				return;
			}

			await goto("/guilds");
		}
	});

	const { form: formData, enhance } = form;
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

	<div class="relative flex min-h-svh items-center justify-center p-4">
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
					<Card.Title class="text-xl">Welcome back</Card.Title>
					<Card.Description>
						Sign in to your home server to continue.
					</Card.Description>
				</div>
			</Card.Header>

			<Card.Content>
				<form method="POST" class="space-y-4" use:enhance>
					<Form.Field {form} name="homeServer" class="space-y-1.5">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>Home server</Form.Label>
								<div class="relative">
									<Server
										class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									/>
									<Input
										{...props}
										bind:value={$formData.homeServer}
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

					<Form.Field {form} name="password" class="space-y-1.5">
						<Form.Control>
							{#snippet children({ props })}
								<div class="flex items-center justify-between">
									<Form.Label>Password</Form.Label>
									<button
										type="button"
										tabindex="-1"
										class="text-xs text-muted-foreground transition-colors hover:text-foreground"
									>
										Forgot password?
									</button>
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
							<span>Continue</span>
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
				<span>Don't have an account?</span>
				<a
					href="/register"
					class="ml-1 font-medium text-foreground underline-offset-4 transition-colors hover:underline"
				>Register</a
				>
			</Card.Footer>
		</Card.Root>
	</div>
</div>
