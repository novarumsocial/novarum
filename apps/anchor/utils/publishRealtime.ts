import type { Server } from 'elysia/universal';
import type { RealtimeEvent } from './types';

export function publishRealtime(server: Server, topic: string, event: RealtimeEvent) {
  server.publish(topic, JSON.stringify(event));
}
