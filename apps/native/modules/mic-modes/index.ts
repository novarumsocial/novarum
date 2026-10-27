import { requireOptionalNativeModule } from 'expo';

// iOS only; null on Android and in builds without the module
export const MicModes = requireOptionalNativeModule<{ showPicker(): void }>('MicModes');
