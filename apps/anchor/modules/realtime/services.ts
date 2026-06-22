import Elysia, { t } from "elysia";
import { sessionCookieName, validateSessionToken } from "../auth/provider";

export const realtime = new Elysia({ prefix: '/realtime' })
	.ws('/', {
		cookie: t.Cookie({
			[sessionCookieName]: t.Optional(t.String()),
		}),
		async open(ws) {
			const token = ws.data.cookie[sessionCookieName]?.value as string | undefined;
			const session = await validateSessionToken(token);
			if (!session) {
				ws.close(1008, 'Unauthorized');
				return;
			}

			ws.subscribe(`guildEvents:${session.userId}`);
			ws.subscribe(`channelEvents:${session.userId}`);
		}
	})