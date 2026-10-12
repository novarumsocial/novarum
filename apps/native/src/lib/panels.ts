// Native-only: which side panel is open. The web has `mobileNavigationOpen` / `mobileMembersOpen`
// in app-shell.svelte; on the phone they are one value because only one panel can be open at a time.
import { create } from 'zustand';

type PanelsState = {
  open: 'left' | 'right' | null;
  openLeft: () => void; // servers + channels, or DMs
  openRight: () => void; // members
  close: () => void;
};

export const usePanels = create<PanelsState>((set) => ({
  open: null,
  openLeft: () => set({ open: 'left' }),
  openRight: () => set({ open: 'right' }),
  close: () => set({ open: null }),
}));

export const panels = usePanels.getState;
