import { anchor } from '$lib/anchor.svelte';

type MeData = Awaited<ReturnType<typeof anchor.client.auth.me.get>>['data'];
export type SessionUser = NonNullable<MeData>['user'];

type LoginInput = {
  homeServer: string;
  username: string;
  password: string;
};

type SignupInput = {
  homeServer: string;
  username: string;
  displayName?: string;
  email: string;
  password: string;
};

type SessionResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string; cookieMissing?: boolean };

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'error' in error) {
    return String(error.error);
  }

  return fallback;
}

class SessionState {
  user = $state<SessionUser | null>(null);
  loading = $state(false);
  initialized = $state(false);
  error = $state<string | null>(null);

  authenticated = $derived(Boolean(this.user));

  async refresh() {
    this.loading = true;
    this.error = null;

    try {
      const me = await anchor.client.auth.me.get();
      this.user = me.data?.user ?? null;
      return this.user;
    } catch {
      this.user = null;
      this.error = 'Could not load your session.';
      return null;
    } finally {
      this.initialized = true;
      this.loading = false;
    }
  }

  async login(input: LoginInput): Promise<SessionResult> {
    this.loading = true;
    this.error = null;

    try {
      await anchor.setHomeServer(input.homeServer);

      const { error } = await anchor.client.auth.login.post({
        username: input.username,
        password: input.password,
      });

      if (error) {
        this.error = getErrorMessage(error.value, 'Could not sign you in.');
        return { ok: false, error: this.error };
      }

      const user = await this.refresh();
      if (!user) {
        this.error =
          'Sign-in worked, but your browser did not keep the session cookie. Enable third-party cookies for this site, then try again.';
        return { ok: false, error: this.error, cookieMissing: true };
      }

      return { ok: true, user };
    } catch {
      this.error = 'Could not discover that home server.';
      return { ok: false, error: this.error };
    } finally {
      this.loading = false;
    }
  }

  async signup(input: SignupInput): Promise<SessionResult> {
    this.loading = true;
    this.error = null;

    try {
      await anchor.setHomeServer(input.homeServer);

      const { error } = await anchor.client.auth.signup.post({
        username: input.username,
        displayName: input.displayName,
        email: input.email,
        password: input.password,
      });

      if (error) {
        this.error = getErrorMessage(error.value, 'Could not create your account.');
        return { ok: false, error: this.error };
      }

      const user = await this.refresh();
      if (!user) {
        this.error =
          'Account created, but your browser did not keep the session cookie. Enable third-party cookies for this site, then sign in.';
        return { ok: false, error: this.error, cookieMissing: true };
      }

      return { ok: true, user };
    } catch {
      this.error = 'Could not discover that home server.';
      return { ok: false, error: this.error };
    } finally {
      this.loading = false;
    }
  }

  async logout() {
    this.loading = true;
    this.error = null;

    try {
      await anchor.client.auth.logout.post();
    } finally {
      this.user = null;
      this.initialized = true;
      this.loading = false;
    }
  }
}

export const session = new SessionState();

export function useSession() {
  return session;
}
