import { RoomServiceClient } from "livekit-server-sdk";
import { getConfig } from "../config";

export const livekitServiceClient = new RoomServiceClient(
	getConfig().voice.livekit_url,
	getConfig().voice.livekit_key,
	getConfig().voice.livekit_secret
);