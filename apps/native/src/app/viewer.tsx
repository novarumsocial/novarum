// Port of apps/frontend/src/lib/components/attachment-viewer.svelte (the dialog becomes a full-screen modal route)
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AttachmentViewer, viewerParamsSchema } from '@/components/attachment-viewer';

export default function ViewerScreen() {
  const parsed = viewerParamsSchema.safeParse(useLocalSearchParams());
  const valid = parsed.success && parsed.data.attachments.length > 0;

  useEffect(() => {
    if (!valid) router.back();
  }, [valid]);

  return (
    <>
      {/* the root stack paints every screen with the theme background; the viewer draws its own backdrop */}
      <Stack.Screen
        options={{
          presentation: 'transparentModal',
          animation: 'fade',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      <StatusBar style="light" />
      {parsed.success && valid && (
        <AttachmentViewer
          attachments={parsed.data.attachments}
          initialIndex={parsed.data.index}
          authorName={parsed.data.authorName}
          avatarUrl={parsed.data.avatarUrl}
          avatarColor={parsed.data.avatarColor}
          timestamp={parsed.data.timestamp ? new Date(parsed.data.timestamp) : undefined}
          onClose={() => router.back()}
        />
      )}
    </>
  );
}
