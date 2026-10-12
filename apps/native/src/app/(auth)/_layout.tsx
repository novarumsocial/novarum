// Native-only: groups the auth screens in a plain stack (the web uses separate routes)
import { Stack } from 'expo-router';

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />;
}
