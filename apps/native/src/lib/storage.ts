// Native-only: our `localStorage`. MMKV is synchronous like it, so stores can read their values at startup.
import { createMMKV } from 'react-native-mmkv';

export const storage = createMMKV();
