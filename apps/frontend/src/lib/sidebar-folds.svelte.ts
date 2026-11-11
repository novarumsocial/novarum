// Which sidebar sections (servers by id, plus 'dms') the user folded or unfolded by hand.
// Sections without an entry follow their own default.
import { z } from 'zod';

const KEY = 'novarum:sidebar-folds';

function load() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return z.record(z.string(), z.boolean()).parse(stored);
  } catch {
    return {};
  }
}

class SidebarFolds {
  open = $state<Record<string, boolean>>(load());

  isOpen(id: string, fallback: boolean) {
    return this.open[id] ?? fallback;
  }

  set(id: string, open: boolean) {
    this.open = { ...this.open, [id]: open };
    localStorage.setItem(KEY, JSON.stringify(this.open));
  }
}

export const sidebarFolds = new SidebarFolds();
