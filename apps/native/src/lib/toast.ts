// Native-only: short, non-blocking feedback ("Copied", "Saved to your photos", soft errors). One at a time;
// a new one replaces the old. `action` adds a button, like "Open settings" or "Undo".
import { create } from 'zustand';

export type Toast = {
  id: number;
  message: string;
  tone: 'default' | 'error';
  action?: { label: string; onPress: () => void };
};

export const useToast = create<{ current: Toast | null }>(() => ({ current: null }));

let nextId = 0;

export function toast(
  message: string,
  options: { tone?: Toast['tone']; action?: Toast['action'] } = {}
) {
  useToast.setState({
    current: { id: ++nextId, message, tone: options.tone ?? 'default', ...options },
  });
}

export const dismissToast = () => useToast.setState({ current: null });
