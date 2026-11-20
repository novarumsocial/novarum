// Native-only: the ring notification opened the app (novarum://call/<dm>, see app/+native-intent.ts), over the
// lock screen unless it was the notification's Answer button. Kept apart from the dms store so the link handler,
// which runs while the router starts, imports nothing else.
import { create } from 'zustand';

export type CallLink = { channelId: string; answer: boolean };

export const useCallLink = create<{ link: CallLink | null }>(() => ({ link: null }));

export const setCallLink = (link: CallLink | null) => useCallLink.setState({ link });
