export interface Server {
	id: string;
	name: string;
	initials: string;
	color: string;
}

export interface ChannelCategory {
	id: string;
	label: string;
	channels: Channel[];
}

export interface Channel {
	id: string;
	name: string;
	label?: string;
	topic?: string;
	unread: boolean;
	mention: number;
	type: "text" | "voice" | "federated";
}

export interface Author {
	username: string;
	server: string;
	displayName: string;
	avatarColor: string;
	isBot: boolean;
}

export interface Message {
	id: string;
	author: Author;
	content: string;
	timestamp: Date;
	edited: boolean;
	fromFederated: boolean;
	replies: number;
}

export interface VoiceUser {
	username: string;
	server: string;
	avatarColor: string;
	muted: boolean;
	deafened: boolean;
	speaking: boolean;
}

export const servers: Server[] = [
	{ id: "home", name: "Home", initials: "N", color: "bg-primary" },
	{ id: "dev", name: "Novarum Dev", initials: "ND", color: "bg-emerald-600" },
	{ id: "federation", name: "Federation WG", initials: "FW", color: "bg-violet-600" },
	{ id: "design", name: "Design System", initials: "DS", color: "bg-amber-600" },
	{ id: "ecosystem", name: "Federated Ecosystem", initials: "FE", color: "bg-cyan-600" },
];

export const channelsByServer: Record<string, ChannelCategory[]> = {
	home: [
		{
			id: "cat-welcome",
			label: "Welcome",
			channels: [
				{ id: "ch-welcome", name: "welcome", label: "Welcome", topic: "Introduce yourself to the network", unread: false, mention: 0, type: "text" },
				{ id: "ch-rules", name: "rules", label: "Rules", topic: "Network-wide code of conduct", unread: false, mention: 0, type: "text" },
			],
		},
		{
			id: "cat-general",
			label: "General",
			channels: [
				{ id: "ch-general", name: "general", topic: "Cross-server general discussion", unread: true, mention: 0, type: "text" },
				{ id: "ch-announcements", name: "announcements", topic: "Network-wide announcements", unread: false, mention: 0, type: "text" },
			],
		},
		{
			id: "cat-fed",
			label: "Federated",
			channels: [
				{ id: "ch-fed-lounge", name: "fed-lounge", label: "🌐 fed-lounge", topic: "Chat with users from other servers", unread: true, mention: 2, type: "federated" },
				{ id: "ch-fed-support", name: "fed-support", label: "🌐 fed-support", topic: "Cross-server help & support", unread: false, mention: 0, type: "federated" },
			],
		},
		{
			id: "cat-voice",
			label: "Voice",
			channels: [
				{ id: "ch-vc-general", name: "General", topic: "General voice chat", unread: false, mention: 0, type: "voice" },
				{ id: "ch-vc-lounge", name: "Lounge", topic: "Voice lounge", unread: false, mention: 0, type: "voice" },
			],
		},
	],
	dev: [
		{
			id: "cat-dev-text",
			label: "Text Channels",
			channels: [
				{ id: "ch-dev-chat", name: "dev-chat", topic: "Sprint discussion", unread: true, mention: 1, type: "text" },
				{ id: "ch-prs", name: "pull-requests", topic: "PR review queue", unread: true, mention: 0, type: "text" },
				{ id: "ch-bugs", name: "bug-tracker", topic: "Bug reports & reproduction steps", unread: false, mention: 0, type: "text" },
			],
		},
	],
	federation: [
		{
			id: "cat-fed-wg",
			label: "Working Group",
			channels: [
				{ id: "ch-spec", name: "spec-discussion", topic: "Federation protocol specification", unread: false, mention: 0, type: "text" },
				{ id: "ch-implement", name: "implementation", topic: "Server implementation tracking", unread: true, mention: 0, type: "text" },
			],
		},
	],
	design: [
		{
			id: "cat-design",
			label: "Design",
			channels: [
				{ id: "ch-design-chat", name: "design-chat", topic: "Visual language discussions", unread: false, mention: 0, type: "text" },
				{ id: "ch-assets", name: "assets", topic: "Shared design assets", unread: false, mention: 0, type: "text" },
			],
		},
	],
	ecosystem: [
		{
			id: "cat-ecosystem",
			label: "Network",
			channels: [
				{ id: "ch-showcase", name: "server-showcase", topic: "Show off your novarum server", unread: false, mention: 0, type: "text" },
				{ id: "ch-relay", name: "relay-status", topic: "Federation relay health", unread: false, mention: 0, type: "text" },
			],
		},
	],
};

const localServer = "novarum.social";

export const authors: Record<string, Author> = {
	alice: { username: "alice", server: localServer, displayName: "Alice Chen", avatarColor: "bg-blue-500", isBot: false },
	bob: { username: "bob", server: "matrix.org", displayName: "Bob Williams", avatarColor: "bg-amber-500", isBot: false },
	carol: { username: "carol", server: "fedi.space", displayName: "Carol Santana", avatarColor: "bg-rose-500", isBot: false },
	dave: { username: "dave", server: localServer, displayName: "Dave Park", avatarColor: "bg-emerald-500", isBot: false },
	eve: { username: "eve", server: "chat.revolt.chat", displayName: "Eve Novak", avatarColor: "bg-violet-500", isBot: false },
	frank: { username: "frank", server: localServer, displayName: "Frank Lin", avatarColor: "bg-cyan-500", isBot: false },
	relay: { username: "relay", server: localServer, displayName: "Federation Relay", avatarColor: "bg-neutral-500", isBot: true },
	mod: { username: "mod", server: localServer, displayName: "Novarum Mod", avatarColor: "bg-red-500", isBot: false },
};

const now = new Date();
function ago(minutes: number): Date {
	const d = new Date(now);
	d.setMinutes(d.getMinutes() - minutes);
	return d;
}

export const messagesByChannel: Record<string, Message[]> = {
	"ch-general": [
		{
			id: "m1",
			author: authors.relay,
			content: "**Federation relay online** - 12 servers reachable. Average latency: 84ms.",
			timestamp: ago(120),
			edited: false,
			fromFederated: false,
			replies: 3,
		},
		{
			id: "m2",
			author: authors.alice,
			content: "good morning everyone! anyone else seeing the new relay nodes lighting up?",
			timestamp: ago(95),
			edited: false,
			fromFederated: false,
			replies: 0,
		},
		{
			id: "m3",
			author: authors.bob,
			content: "Morning Alice! Yeah, I noticed `matrix.org` is now routing through the new eu-2 relay. Latency dropped ~40ms from my end.",
			timestamp: ago(88),
			edited: false,
			fromFederated: true,
			replies: 2,
		},
		{
			id: "m4",
			author: authors.carol,
			content: "can confirm from fedi.space - federation traffic is noticeably snappier today. nice work on the relay optimization!",
			timestamp: ago(72),
			edited: false,
			fromFederated: true,
			replies: 0,
		},
		{
			id: "m5",
			author: authors.dave,
			content: "the new compression codec made a big difference. we're seeing ~35% less bandwidth per message across the federation boundary.",
			timestamp: ago(60),
			edited: false,
			fromFederated: false,
			replies: 4,
		},
		{
			id: "m6",
			author: authors.eve,
			content: "ooooh that explains why revolt.chat side feels faster too! do we have docs on the codec yet? would love to read up on it",
			timestamp: ago(45),
			edited: false,
			fromFederated: true,
			replies: 0,
		},
		{
			id: "m7",
			author: authors.dave,
			content: "yep, I'll drop a link in #spec-discussion once I clean it up. it's based on a modified varint scheme with dictionary compression for common message patterns.",
			timestamp: ago(38),
			edited: true,
			fromFederated: false,
			replies: 0,
		},
		{
			id: "m8",
			author: authors.alice,
			content: "@frank - any update on the homeserver discovery spec? the WG was asking about it",
			timestamp: ago(25),
			edited: false,
			fromFederated: false,
			replies: 1,
		},
		{
			id: "m9",
			author: authors.frank,
			content: "yeah! draft is nearly ready. we're using DNS-based discovery similar to Matrix but with our own SRV record format. I'll have the spec PR up by EOD",
			timestamp: ago(20),
			edited: false,
			fromFederated: false,
			replies: 0,
		},
		{
			id: "m10",
			author: authors.bob,
			content: "nice. would love to see the SRV format early - we're planning matrix.org's novarum bridge and need to align on discovery",
			timestamp: ago(12),
			edited: false,
			fromFederated: true,
			replies: 0,
		},
		{
			id: "m11",
			author: authors.mod,
			content: "🔔 **reminder**: federation WG meeting in 30 minutes in the WG voice channel. agenda: relay trust model v2 & homeserver discovery spec review",
			timestamp: ago(8),
			edited: false,
			fromFederated: false,
			replies: 0,
		},
	],
	"ch-welcome": [
		{
			id: "wm1",
			author: authors.relay,
			content: "Welcome to **novarum** - your federated chat network. This is a global channel, reachable from any connected server. Introduce yourself and say hello!",
			timestamp: ago(9999),
			edited: false,
			fromFederated: false,
			replies: 0,
		},
		{
			id: "wm2",
			author: authors.carol,
			content: "hi from fedi.space! 👋 excited to see novarum growing. we've been federating for about a week now and it's been smooth",
			timestamp: ago(4320),
			edited: false,
			fromFederated: true,
			replies: 4,
		},
	],
	"ch-fed-lounge": [
		{
			id: "fl1",
			author: authors.carol,
			content: "question for the wider federation: how are you all handling media storage? s3? local? something custom?",
			timestamp: ago(60),
			edited: false,
			fromFederated: true,
			replies: 6,
		},
		{
			id: "fl2",
			author: authors.eve,
			content: "we're using local storage with S3 mirroring on revolt.chat. working well so far but the caching layer needs work",
			timestamp: ago(52),
			edited: false,
			fromFederated: true,
			replies: 0,
		},
		{
			id: "fl3",
			author: authors.bob,
			content: "matrix.org runs object storage with presigned URLs. happy to share our terraform configs if anyone's setting up",
			timestamp: ago(40),
			edited: false,
			fromFederated: true,
			replies: 3,
		},
		{
			id: "fl4",
			author: authors.frank,
			content: "novarum.social is using S3-compatible (Backblaze B2). dirt cheap and works great with our proxy caching layer",
			timestamp: ago(30),
			edited: false,
			fromFederated: false,
			replies: 0,
		},
	],
};

export const members: Author[] = [
	authors.alice, authors.bob, authors.carol, authors.dave,
	authors.eve, authors.frank, authors.relay, authors.mod,
];

export const voiceUsers: VoiceUser[] = [
	{ username: "alice", server: localServer, avatarColor: "bg-blue-500", muted: false, deafened: false, speaking: true },
	{ username: "dave", server: localServer, avatarColor: "bg-emerald-500", muted: false, deafened: false, speaking: false },
	{ username: "bob", server: "matrix.org", avatarColor: "bg-amber-500", muted: true, deafened: false, speaking: false },
	{ username: "frank", server: localServer, avatarColor: "bg-cyan-500", muted: false, deafened: false, speaking: false },
];
