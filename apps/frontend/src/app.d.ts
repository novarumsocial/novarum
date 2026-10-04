// See https://svelte.dev/docs/kit/types#app.d.ts

import type { ElectronAPI } from '$lib/electron-api';

// for information about these interfaces
declare global {
  const __FRONTEND_VERSION__: string;
  const __GIT_COMMIT_HASH__: string;
  const __LOCAL_BUILD__: boolean;
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
  interface Window {
    electron?: ElectronAPI;
  }
}

export {};
