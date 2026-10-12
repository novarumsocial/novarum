// Port of apps/frontend/src/lib/components/attachment-viewer.svelte (the dialog becomes a full-screen modal route)
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { AttachmentViewer, viewerParamsSchema } from '@/components/attachment-viewer';

export default function ViewerScreen() {
  const parsed = viewerParamsSchema.safeParse(useLocalSearchParams());

  useEffect(() => {
    if (!parsed.success || parsed.data.attachments.length === 0) router.back();
  }, [parsed]);

  return (
    <>
      <Stack.Screen options={{ presentation: 'transparentModal', animation: 'fade' }} />
      {parsed.success && parsed.data.attachments.length > 0 && (
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
