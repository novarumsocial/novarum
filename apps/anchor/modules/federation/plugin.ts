import Elysia from 'elysia';
import { z } from 'zod';
import { federationUserSchema } from '../../utils/federationPayload';
import { verifiedFederationJsonBody } from './verify';

// Every federation POST route starts with the same checks, so routes opt in with an option
// instead of repeating them:
//
//   .post('/typing', ({ origin, remoteUser }) => ..., { federatedUser: true })
//
// `federated`      checks the signature, and hands the handler `origin` (the verified remote
//                  homeserver) and `payload` (the parsed JSON body).
// `federatedUser`  does the same, then also checks that `payload.user` is a user of that homeserver
//                  and hands the handler `remoteUser`.
//
// A failing check answers with the error straight away and the handler never runs.
const bodyWithUserSchema = z.looseObject({ user: federationUserSchema });

export const federationAuth = new Elysia({ name: 'federation-auth' }).macro({
  federated: {
    async resolve({ request, status }) {
      const verified = await verifiedFederationJsonBody(request);
      if (!verified.ok) return status(verified.status, { error: verified.error });

      return { origin: verified.origin, payload: verified.body };
    },
  },
  federatedUser: {
    async resolve({ request, status }) {
      const verified = await verifiedFederationJsonBody(request);
      if (!verified.ok) return status(verified.status, { error: verified.error });

      const body = bodyWithUserSchema.safeParse(verified.body);
      if (!body.success) return status(400, { error: 'Invalid federation user' });

      // without this a server could act as users of any other server
      const remoteUser = body.data.user;
      if (remoteUser.homeserver.toLowerCase() !== verified.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      return { origin: verified.origin, payload: body.data, remoteUser };
    },
  },
});
