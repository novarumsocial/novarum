// Conversations shown as tabs above the chat, VS Code style: opening a conversation shows it in
// a single preview tab that the next one replaces, and it only becomes a kept tab once you
// interact with it (send a message, or double-click it). Only ids are stored; names and unread
// state are looked up live (see conversations.svelte.ts), so a stale id simply isn't shown.
import { z } from 'zod';

const KEY = 'novarum:tabs';
const LIMIT = 8;
const schema = z.object({ kept: z.array(z.string()), preview: z.string().nullable() });

function load() {
  if (typeof localStorage === 'undefined') return { kept: [], preview: null };
  try {
    return schema.parse(JSON.parse(localStorage.getItem(KEY) ?? ''));
  } catch {
    return { kept: [], preview: null };
  }
}

class TabsState {
  kept = $state<string[]>([]);
  preview = $state<string | null>(null);
  ids = $derived(this.preview ? [...this.kept, this.preview] : this.kept);

  constructor() {
    ({ kept: this.kept, preview: this.preview } = load());
  }

  private save() {
    localStorage.setItem(KEY, JSON.stringify({ kept: this.kept, preview: this.preview }));
  }

  show(id: string) {
    if (this.kept.includes(id) || this.preview === id) return;
    this.preview = id;
    this.save();
  }

  keep(id: string) {
    if (this.kept.includes(id)) return;
    if (this.preview === id) this.preview = null;
    this.kept = [...this.kept, id].slice(-LIMIT);
    this.save();
  }

  close(id: string) {
    if (this.preview === id) this.preview = null;
    this.kept = this.kept.filter((tab) => tab !== id);
    this.save();
  }
}

export const tabs = new TabsState();
