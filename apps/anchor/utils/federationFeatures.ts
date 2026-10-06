// Optional parts of the federation protocol that older homeservers don't have.
// A homeserver lists the ones it supports in /.well-known/anchor/info. We only use one of them
// with a remote that lists it, so talking to an older homeserver keeps working the old way.
export const federationFeatures = [
  // one WebSocket per homeserver for every guild and DM, instead of one per guild or DM
  'realtime-mux',
  // one request per homeserver to tell it a user went online or offline
  'status-batch',
] as const;

export type FederationFeature = (typeof federationFeatures)[number];

export const remoteSupports = (remote: { features: string[] }, feature: FederationFeature) =>
  remote.features.includes(feature);
