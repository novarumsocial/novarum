import { TOML } from "bun";
import { readFileSync } from "node:fs";
import { z } from "zod";

const schema = z.object({
	server: z.object({
		database_url: z.string().regex(/^postgresql:\/\/.*$/),
		homeserver: z.string().regex(/^[a-zA-Z0-9.-]+$/),
		baseUrl: z.url(),
	}),
	federation: z.object({
		key_dir: z.string().optional().default("./keys"),
		nonce_max_age_seconds: z.number().positive().optional().default(300),
	}).default({ key_dir: "./keys", nonce_max_age_seconds: 300 }),
});

export type Config = z.infer<typeof schema>;

export function getConfig() {
	// doing readfilesync so its not a pain to work with
	const config = schema.parse(TOML.parse(readFileSync("./config.toml").toString()));	
	return config;
}
