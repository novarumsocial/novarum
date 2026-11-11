// Conversations the user has open, shown as tabs above the chat. Only ids are stored; names and
// unread state are looked up live (see conversations.svelte.ts), so a stale id simply isn't shown.
import { z } from 'zod';

const KEY = 'novarum:tabs';
const LIMIT = 8;

function load() {
  if (typeof localStorage === 'undefined') return [];
  try {
    return z.array(z.string()).parse(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

class TabsState {
  ids = $state<string[]>(load());

  private set(ids: string[]) {
    this.ids = ids;
    localStorage.setItem(KEY, JSON.stringify(ids));
  }

  open(id: string) {
    if (!this.ids.includes(id)) this.set([...this.ids, id].slice(-LIMIT));
  }

  close(id: string) {
    this.set(this.ids.filter((tab) => tab !== id));
  }
}

export const tabs = new TabsState();
