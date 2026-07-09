import { anchor } from '$lib/anchor.svelte';
import { z } from 'zod';

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
  const stringError = z.string().safeParse(error);
  if (stringError.success) return stringError.data;

  const apiError = z.object({ error: z.string() }).safeParse(error);
  if (apiError.success) return apiError.data.error;

  const validationError = z.object({ message: z.string() }).safeParse(error);
  if (validationError.success) return validationError.data.message;

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

      const sessionResult = await this.verifyNewSession('Sign-in');
      if (!sessionResult.ok) return sessionResult;

      return sessionResult;
    } catch (error) {
      this.error = getErrorMessage(error, 'Could not sign you in. Try again.');
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

      const sessionResult = await this.verifyNewSession('Account creation');
      if (!sessionResult.ok) return sessionResult;

      return sessionResult;
    } catch (error) {
      this.error = getErrorMessage(error, 'Could not create your account. Try again.');
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

  private async verifyNewSession(action: string): Promise<SessionResult> {
    try {
      const { data, error, response } = await anchor.client.auth.me.get();
      if (error) {
        if (response.status === 401) {
          this.error = `${action} succeeded, but the server did not receive a valid session cookie. Enable third-party cookies for this site, then try again.`;
          return { ok: false, error: this.error, cookieMissing: true };
        }

        this.error = getErrorMessage(
          error.value,
          `${action} succeeded, but the server could not verify the new session.`
        );
        return { ok: false, error: this.error };
      }

      if (!data?.user) {
        this.error = `${action} succeeded, but the server returned no authenticated session.`;
        return { ok: false, error: this.error };
      }

      this.user = data.user;
      this.initialized = true;
      return { ok: true, user: data.user };
    } catch (error) {
      this.error = getErrorMessage(
        error,
        `${action} succeeded, but the new session could not be verified. Check your connection and try again.`
      );
      return { ok: false, error: this.error };
    }
  }
}

export const session = new SessionState();

export function useSession() {
  return session;
}
