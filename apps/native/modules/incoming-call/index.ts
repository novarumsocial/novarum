import { requireOptionalNativeModule } from 'expo';

// Android only (android/): the ring notification, and showing the app over the lock screen while it rings.
// null on iOS and in builds without the module.
export const IncomingCall = requireOptionalNativeModule<{
  cancel(channelId: string): void;
  isLocked(): boolean;
  unlock(): void;
  release(): void;
}>('IncomingCall');
