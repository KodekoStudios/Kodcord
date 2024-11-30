import type { ArgumentTypes } from "@types";

import type { Client } from "@core/client";

// //

import { GUILD_BAN_ADD, GUILD_CREATE } from "./guild.event";
import { MESSAGE_CREATE } from "./message.event";
import { USER_UPDATE } from "./user.event";

// //

export const RAW_EVENTS = { MESSAGE_CREATE, GUILD_CREATE, GUILD_BAN_ADD, USER_UPDATE };

// //

export type ClientEvents = {
	[EventName in keyof typeof RAW_EVENTS]: ReturnType<(typeof RAW_EVENTS)[EventName]>;
};

export type EventNames = Extract<keyof ClientEvents, string>;

export type PredicateEventHandler2 = {
	[K in EventNames]: (...data: ArgumentTypes<(typeof RAW_EVENTS)[K]>) => unknown;
};

export type PredicateEventHandler = {
	[K in EventNames]: (...data: [Awaited<ClientEvents[K]>, Client]) => unknown;
};
