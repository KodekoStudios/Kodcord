import { type APIUser, GatewayIntentBits, GatewayDispatchEvents } from "discord-api-types/v10";
import { Client, Note } from "../lib";
import { inspect } from "node:util";

const CLIENT = new Client({
	intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
	token: process.env.DISCORD_TOKEN as string,
});

CLIENT.shards.create(0);

const USER = await CLIENT.rest.get<APIUser>("/users/@me");
new Note("Client > User", inspect(USER, { depth: null })).note();

CLIENT.events.set(GatewayDispatchEvents.MessageCreate, (data) => {
	new Note("Client > MessageCreate", inspect(data, { depth: null })).note();
});

CLIENT.connect();
