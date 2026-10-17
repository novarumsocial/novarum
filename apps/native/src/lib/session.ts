// Port of apps/frontend/src/lib/session.svelte.ts
import { create } from 'zustand';
import { z } from 'zod';
import { anchor } from './anchor';
import { storage } from './storage';

type MeData = Awaited<ReturnType<ReturnType<typeof anchor>['client']['auth']['me']['get']>>['data'];
export type SessionUser = NonNullable<MeData>['user'];

type LoginInput = { homeServer: string; username: string; password: string };

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

export type MfaMethod = 'EMAIL' | 'TOTP';
export type LoginResult =
  | SessionResult
  | { ok: true; mfa: { challenge: string; methods: MfaMethod[] } };

export function getErrorMessage(error: unknown, fallback: string) {
  const stringError = z.string().safeParse(error);
  if (stringError.success) return stringError.data;

  const apiError = z.object({ error: z.string() }).safeParse(error);
  if (apiError.success) return apiError.data.error;

  const validationError = z.object({ message: z.string() }).safeParse(error);
  if (validationError.success) return validationError.data.message;

  return fallback;
}

const accountsStorageKey = 'novarum:accounts';
const accountsSchema = z.array(
  z.object({
    homeServer: z.string(),
    username: z.string(),
    displayName: z.string().nullish(),
    avatarUrl: z.string().nullish(),
    avatarColor: z.string().nullish(),
  })
);
export type Account = z.infer<typeof accountsSchema>[number];

const storedAccounts = accountsSchema.safeParse(
  JSON.parse(storage.getString(accountsStorageKey) ?? 'null')
);

type SessionState = {
  user: SessionUser | null;
  // one per homeserver: the session cookie is shared by every account on the same server
  accounts: Account[];
  loading: boolean;
  initialized: boolean;
  error: string | null;
  // bumped when the account behind the shell changes (switch, sign-in): the shell resets its stores and boots again
  epoch: number;
  refresh: () => Promise<SessionUser | null>;
  login: (input: LoginInput) => Promise<LoginResult>;
  completeMfa: (challenge: string, method: MfaMethod, code: string) => Promise<SessionResult>;
  sendMfaEmail: (challenge: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  signup: (input: SignupInput) => Promise<SessionResult>;
  switchAccount: (homeServer: string) => Promise<void>;
  forget: (homeServer: string) => void;
  logout: () => Promise<void>;
};

export const useSession = create<SessionState>((set, get) => {
  const remember = (user: SessionUser) => {
    const account = {
      homeServer: anchor().homeServer,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      avatarColor: user.avatarColor,
    };
    setAccounts([
      ...get().accounts.filter((other) => other.homeServer !== account.homeServer),
      account,
    ]);
  };

  const setAccounts = (accounts: Account[]) => {
    set({ accounts });
    storage.set(accountsStorageKey, JSON.stringify(accounts));
  };

  const fail = (error: unknown, fallback: string) => {
    const message = getErrorMessage(error, fallback);
    set({ error: message });
    return { ok: false as const, error: message };
  };

  const verifyNewSessionOnce = async (action: string): Promise<SessionResult> => {
    try {
      const { data, error, response } = await anchor().client.auth.me.get();
      if (error) {
        if (response.status === 401) {
          const result = fail(
            `${action} succeeded, but the server could not verify the new session. Try again.`,
            ''
          );
          return { ...result, cookieMissing: true };
        }
        return fail(
          error.value,
          `${action} succeeded, but the server could not verify the new session.`
        );
      }

      if (!data?.user) {
        return fail(`${action} succeeded, but the server returned no authenticated session.`, '');
      }

      set({ user: data.user, initialized: true, epoch: get().epoch + 1 });
      remember(data.user);
      return { ok: true, user: data.user };
    } catch (error) {
      return fail(
        error,
        `${action} succeeded, but the new session could not be verified. Check your connection and try again.`
      );
    }
  };

  const verifyNewSession = async (action: string): Promise<SessionResult> => {
    const result = await verifyNewSessionOnce(action);
    if (result.ok) return result;

    await new Promise((resolve) => setTimeout(resolve, 1000));
    return verifyNewSessionOnce(action);
  };

  return {
    user: null,
    accounts: storedAccounts.success ? storedAccounts.data : [],
    loading: false,
    initialized: false,
    error: null,
    epoch: 0,

    async refresh() {
      set({ loading: true, error: null });

      try {
        const me = await anchor().client.auth.me.get();
        const user = me.data?.user ?? null;
        set({ user });
        if (user) remember(user);
        return user;
      } catch {
        set({ user: null, error: 'Could not load your session.' });
        return null;
      } finally {
        set({ initialized: true, loading: false });
      }
    },

    async login(input) {
      set({ loading: true, error: null });

      try {
        await anchor().setHomeServer(input.homeServer);

        const { data, error } = await anchor().client.auth.login.post({
          username: input.username,
          password: input.password,
        });

        if (error) return fail(error.value, 'Could not sign you in.');

        if (data && 'mfaRequired' in data) {
          return { ok: true, mfa: { challenge: data.challenge, methods: data.methods } };
        }

        return await verifyNewSession('Sign-in');
      } catch (error) {
        return fail(error, 'Could not sign you in. Try again.');
      } finally {
        set({ loading: false });
      }
    },

    async completeMfa(challenge, method, code) {
      set({ loading: true, error: null });

      try {
        const { error } = await anchor().client.auth.login.mfa.post({ challenge, method, code });
        if (error) return fail(error.value, 'Could not verify that code.');

        return await verifyNewSession('Verification');
      } catch (error) {
        return fail(error, 'Could not verify that code. Try again.');
      } finally {
        set({ loading: false });
      }
    },

    async sendMfaEmail(challenge) {
      try {
        const { error } = await anchor().client.auth.login.mfa.email.post({ challenge });
        if (error)
          return { ok: false, error: getErrorMessage(error.value, 'Could not send the code.') };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: getErrorMessage(error, 'Could not send the code. Try again.') };
      }
    },

    async signup(input) {
      set({ loading: true, error: null });

      try {
        await anchor().setHomeServer(input.homeServer);

        const { error } = await anchor().client.auth.signup.post({
          username: input.username,
          displayName: input.displayName,
          email: input.email,
          password: input.password,
        });

        if (error) return fail(error.value, 'Could not create your account.');

        return await verifyNewSession('Account creation');
      } catch (error) {
        return fail(error, 'Could not create your account. Try again.');
      } finally {
        set({ loading: false });
      }
    },

    // the web reloads the page; here the epoch makes the app shell reset its stores and boot again
    async switchAccount(homeServer) {
      await anchor().setHomeServer(homeServer);
      set({ user: null, initialized: false, epoch: get().epoch + 1 });
    },

    forget: (homeServer) => setAccounts(get().accounts.filter((a) => a.homeServer !== homeServer)),

    async logout() {
      set({ loading: true, error: null });

      try {
        await anchor().client.auth.logout.post();
      } finally {
        set({ user: null, initialized: true, loading: false });
      }
    },
  };
});

// Same name as on the web, for code that runs outside React: `session().user`
export const session = useSession.getState;
