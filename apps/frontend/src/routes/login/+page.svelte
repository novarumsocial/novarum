<script lang="ts">
	import * as Card from "$lib/components/ui/card/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import { Label } from "$lib/components/ui/label/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";
	import {
		MessagesSquare,
		Server,
		Mail,
		Lock,
		ArrowRight,
		LoaderCircle
	} from "@lucide/svelte";
	import ConstellationBackground from "$lib/components/constellation-background.svelte";

	let homeServer = $state("novarum.social");
	let email = $state("");
	let password = $state("");
	let loading = $state(false);
	let error = $state<string | null>(null);

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (loading) return;
		error = null;

		if (!email.trim() || !password) {
			error = "Enter your email and password.";
			return;
		}

		loading = true;
		setTimeout(() => {
			loading = false;
		}, 900);
	}
</script>

<svelte:head>
	<title>novarum — sign in</title>
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
				<form class="space-y-4" onsubmit={handleSubmit} novalidate>
					<div class="space-y-1.5">
						<Label for="homeServer">Home server</Label>
						<div class="relative">
							<Server
								class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								id="homeServer"
								name="homeServer"
								bind:value={homeServer}
								placeholder="novarum.social"
								class="pl-8"
								autocomplete="url"
								spellcheck="false"
							/>
						</div>
					</div>

					<div class="space-y-1.5">
						<Label for="email">Email</Label>
						<div class="relative">
							<Mail
								class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								id="email"
								name="email"
								type="email"
								bind:value={email}
								placeholder="you@example.com"
								class="pl-8"
								autocomplete="email"
							/>
						</div>
					</div>

					<div class="space-y-1.5">
						<div class="flex items-center justify-between">
							<Label for="password">Password</Label>
							<button
								type="button"
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
								id="password"
								name="password"
								type="password"
								bind:value={password}
								placeholder="••••••••"
								class="pl-8"
								autocomplete="current-password"
							/>
						</div>
					</div>

					{#if error}
						<p class="text-xs text-destructive" role="alert">{error}</p>
					{/if}

					<Button type="submit" class="w-full" size="lg" disabled={loading}>
						{#if loading}
							<LoaderCircle class="size-4 animate-spin" />
							<span>Signing in…</span>
						{:else}
							<span>Continue</span>
							<ArrowRight class="size-4" />
						{/if}
					</Button>
				</form>

				<div class="my-5 flex items-center gap-3">
					<Separator class="flex-1" />
					<span class="text-xs text-muted-foreground">or</span>
					<Separator class="flex-1" />
				</div>

				<Button type="button" variant="outline" class="w-full" size="lg">
					Continue with SSO
				</Button>
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
