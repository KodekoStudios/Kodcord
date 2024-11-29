import type { Nullable } from "@types";
import type { ChannelType } from "discord-api-types/v10";
import { BaseChannel } from "./base.channel";

/**
 * Represents a Direct Message (DM) channel in Discord.
 * Provides basic properties for DM channels, such as name and flags.
 */
export class DMChannel extends BaseChannel<ChannelType.DM> {
	/**
	 * Retrieves the name of the DM channel.
	 * This is typically `null` since DM channels don't usually have names.
	 *
	 * @returns A string representing the name of the DM channel, or `null` if not available.
	 */
	public get name(): Nullable<string> {
		return this.data.name;
	}

	/**
	 * Retrieves the flags associated with the DM channel.
	 * Flags are used to represent various states or features of the channel.
	 *
	 * @returns A nullable number representing the channel's flags, or `null` if not set.
	 */
	public get flags(): Nullable<number> {
		return this.data.flags;
	}
}
