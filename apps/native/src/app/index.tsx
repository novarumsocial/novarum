// Port of apps/frontend/src/routes/+page.ts: the root sends you to the app
import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/guilds" />;
}
