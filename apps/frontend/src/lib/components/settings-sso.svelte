<script lang="ts">
  import { onMount } from 'svelte';
  import { anchor } from '$lib/anchor.svelte';
  import { getErrorMessage } from '$lib/session.svelte';
  import { signOnSupported, startSignOn } from '$lib/sso.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SettingsGroup from './settings-group.svelte';
  import SettingsRow from './settings-row.svelte';

  type Identities = NonNullable<
    Awaited<ReturnType<typeof anchor.client.auth.sso.identities.get>>['data']
  >;

  let { onPasswordless }: { onPasswordless?: (passwordless: boolean) => void } = $props();

  let linked = $state<Identities | null>(null);
  let busy = $state<string | null>(null);
  let error = $state('');
  let password = $state('');

  // configured providers first, then ones linked before the server dropped them
  const rows = $derived([
    ...anchor.auth.providers,
    ...(linked?.identities ?? [])
      .filter((identity) => !anchor.auth.providers.some((p) => p.id === identity.provider))
      .map((identity) => ({ id: identity.provider, name: identity.name })),
  ]);

  async function load() {
    const { data, error: loadError } = await anchor.client.auth.sso.identities.get();
    if (loadError) return void (error = getErrorMessage(loadError.value, 'Could not load.'));
    linked = data;
    onPasswordless?.(!data.hasPassword);
  }

  async function link(provider: string) {
    busy = provider;
    error = (await startSignOn(provider, { link: true, redirect: location.pathname })) ?? '';
    busy = null;
  }

  async function unlink(provider: string) {
    busy = provider;
    error = '';
    const { error: unlinkError } = await anchor.client.auth.sso.identities({ provider }).delete();
    if (unlinkError) error = getErrorMessage(unlinkError.value, 'Could not unlink.');
    busy = null;
    await load();
  }

  // the email stays on file, so a password reset can always bring a password back
  async function removePassword() {
    busy = 'password';
    error = '';
    const { error: removeError } = await anchor.client.auth.password.delete({ password });
    if (removeError) error = getErrorMessage(removeError.value, 'Could not remove your password.');
    else password = '';
    busy = null;
    await load();
  }

  onMount(load);
</script>

{#if rows.length && linked}
  <SettingsGroup
    title="Single sign-on"
    description="Accounts you can sign in to {anchor.homeServer} with."
  >
    {#each rows as provider (provider.id)}
      {@const identity = linked.identities.find((i) => i.provider === provider.id)}
      <SettingsRow
        title={provider.name}
        description={identity
          ? `Linked${identity.email ? ` as ${identity.email}` : ''}`
          : undefined}
      >
        {#if identity}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onclick={() => unlink(provider.id)}>Unlink</Button
          >
        {:else if signOnSupported}
          <Button size="sm" disabled={busy !== null} onclick={() => link(provider.id)}>Link</Button>
        {/if}
      </SettingsRow>
    {/each}
    {#if linked.hasPassword && linked.identities.length}
      <SettingsRow
        title="Remove password"
        description="Sign in only with a linked provider. Two-step verification is turned off, and a password reset can bring a password back."
        stacked
      >
        <div class="flex gap-2">
          <Input
            type="password"
            autocomplete="current-password"
            placeholder="Current password"
            bind:value={password}
            class="h-9"
          />
          <Button
            variant="destructive"
            size="sm"
            disabled={busy !== null || !password}
            onclick={removePassword}>Remove</Button
          >
        </div>
      </SettingsRow>
    {/if}
    {#if error}
      <p class="px-4 py-3 text-xs text-destructive">{error}</p>
    {/if}
  </SettingsGroup>
{/if}
