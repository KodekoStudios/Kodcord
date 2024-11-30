import { inflateSync } from "node:zlib";
import { Logger } from "@common/logger";
import { Bucket } from "@core/bucket";
import type { MakeRequired } from "@types";
import {
	GatewayCloseCodes,
	GatewayDispatchEvents,
	type GatewayDispatchPayload,
	GatewayOpcodes,
	type GatewayReceivePayload,
	type GatewaySendPayload,
} from "discord-api-types/v10";
import { ConnectTimeout } from "./shard.timeout";
import {
	type ShardData,
	type ShardHeart,
	type ShardOptions,
	ShardSocketCloseCodes,
} from "./types.d";

export const PROPERTIES = {
	os: process.platform,
	browser: "Seyfert",
	device: "Seyfert",
};

export class Shard {
	public readonly logger?: Logger;

	public data: Partial<ShardData> | ShardData = {
		resume_seq: null,
	};

	public connectTimeout = new ConnectTimeout();

	public websocket: WebSocket | null = null;
	public heart: ShardHeart = {
		interval: 30e3,
		ack: true,
	};

	public bucket: Bucket;
	public offlineSendQueue: ((_?: unknown) => void)[] = [];

	public options: MakeRequired<ShardOptions, "properties" | "ratelimitOptions">;

	public id: number;

	public constructor(id: number, options: ShardOptions) {
		this.id = id;

		this.options = {
			properties: PROPERTIES,
			ratelimitOptions: {
				rateLimitResetInterval: 60_000,
				maxRequestsPerRateLimitTick: 120,
			},
			...options,
		};

		this.logger = options.debug
			? new Logger({
					prefix: "SHARD",
					from: `[Shard #${id}]`,
				})
			: undefined;

		const SAFE = this.calculateSafeRequests();
		this.bucket = new Bucket(SAFE);
	}

	public get latency(): number {
		return this.heart.lastAck && this.heart.lastBeat
			? this.heart.lastAck - this.heart.lastBeat
			: Number.POSITIVE_INFINITY;
	}

	public get isOpen(): boolean {
		return this.websocket?.readyState === 1;
	}

	public get gatewayURL(): string {
		return this.options.info.url;
	}

	public get resumeGatewayURL(): string | undefined {
		return this.data.resume_gateway_url;
	}

	public get currentGatewayURL(): string {
		const GATEWAY_URL = new URL(this.resumeGatewayURL ?? this.options.info.url);
		GATEWAY_URL.searchParams.set("v", "10");
		return GATEWAY_URL.href;
	}

	public ping(): Promise<number> {
		if (!this.websocket) {
			return Promise.resolve(Number.POSITIVE_INFINITY);
		}
		return this.websocket.ping() as unknown as Promise<number>;
	}

	public async connect(): Promise<void> {
		await this.connectTimeout.wait();
		if (this.isOpen) {
			this.logger?.debug(`[Shard #${this.id}] Attempted to connect while open`);
			return;
		}

		clearTimeout(this.heart.nodeInterval);

		this.logger?.debug(`[Shard #${this.id}] Connecting to ${this.currentGatewayURL}`);

		this.websocket = new WebSocket(this.currentGatewayURL);

		this.websocket.onmessage = ({ data }: { data: string | Buffer }): void => {
			this.handleMessage(data);
		};

		this.websocket.onclose = (event: { code: number; reason: string }): Promise<void> =>
			this.handleClosed(event);

		// @ts-expect-error
		this.websocket.onerror = (event: ErrorEvent): void => this.logger?.throw(`${event}`);

		this.websocket.onopen = (): void => {
			this.heart.ack = true;
		};
	}

	public async send<T extends GatewaySendPayload = GatewaySendPayload>(
		force: boolean,
		message: T,
	): Promise<void> {
		this.logger?.inform(
			`[Shard #${this.id}] Sending: ${GatewayOpcodes[message.op]} ${JSON.stringify(
				message.d,
				(_, value) => {
					if (typeof value === "string") {
						return value.replaceAll(this.options.token, (v) => {
							const SPLIT = v.split(".");
							return `${SPLIT[0]}.${"*".repeat(SPLIT[1].length)}.${"*".repeat(SPLIT[2].length)}`;
						});
					}
					return value;
				},
				1,
			)}`,
		);
		await this.checkOffline(force);
		this.bucket.process(force);
		await this.checkOffline(force);
		this.websocket?.send(JSON.stringify(message));
	}

	public async identify(): Promise<void> {
		await this.send(true, {
			op: GatewayOpcodes.Identify,
			d: {
				token: `Bot ${this.options.token}`,
				compress: this.options.compress,
				properties: this.options.properties,
				shard: [this.id, this.options.info.shards],
				intents: this.options.intents,
				presence: this.options.presence,
			},
		});
	}

	public get resumable(): boolean {
		return !!(
			this.data.resume_gateway_url &&
			this.data.session_id &&
			this.data.resume_seq !== null
		);
	}

	public async resume(): Promise<void> {
		await this.send(true, {
			op: GatewayOpcodes.Resume,
			d: {
				seq: this.data.resume_seq ?? 0,
				session_id: this.data.session_id ?? "",
				token: `Bot ${this.options.token}`,
			},
		});
	}

	public async heartbeat(requested: boolean): Promise<void> {
		this.logger?.debug(
			`[Shard #${this.id}] Sending ${requested ? "" : "un"}requested heartbeat (Ack=${this.heart.ack})`,
		);
		if (!requested) {
			if (!this.heart.ack) {
				await this.close(ShardSocketCloseCodes.ZombiedConnection, "Zombied connection");
				return;
			}
			this.heart.ack = false;
		}

		this.heart.lastBeat = Date.now();

		this.websocket?.send(
			JSON.stringify({
				op: GatewayOpcodes.Heartbeat,
				d: this.data.resume_seq ?? null,
			}),
		);
	}

	public async disconnect(): Promise<void> {
		this.logger?.inform(`[Shard #${this.id}] Disconnecting`);
		await this.close(ShardSocketCloseCodes.Shutdown, "Shard down request");
	}

	public async reconnect(): Promise<void> {
		this.logger?.inform(`[Shard #${this.id}] Reconnecting`);
		await this.disconnect();
		await this.connect();
	}

	public async onpacket(packet: GatewayReceivePayload): Promise<void> {
		if (packet.s !== null) {
			this.data.resume_seq = packet.s;
		}

		this.logger?.debug(packet.t ? packet.t : GatewayOpcodes[packet.op], this.data.resume_seq);

		switch (packet.op) {
			case GatewayOpcodes.Hello:
				{
					clearInterval(this.heart.nodeInterval);

					this.heart.interval = packet.d.heartbeat_interval;

					await this.heartbeat(false);
					this.heart.nodeInterval = setInterval(() => this.heartbeat(false), this.heart.interval);

					if (this.resumable) {
						return this.resume();
					}
					await this.identify();
				}
				break;
			case GatewayOpcodes.HeartbeatAck:
				{
					this.heart.ack = true;
					this.heart.lastAck = Date.now();
				}
				break;
			case GatewayOpcodes.Heartbeat:
				this.heartbeat(true);
				break;
			case GatewayOpcodes.Reconnect:
				await this.reconnect();
				break;
			case GatewayOpcodes.InvalidSession:
				if (packet.d) {
					if (!this.resumable) {
						return this.logger?.throw("This is a completely unexpected error message.");
					}
					await this.resume();
				} else {
					this.data.resume_seq = 0;
					this.data.session_id = undefined;
					await this.identify();
				}
				break;
			case GatewayOpcodes.Dispatch:
				{
					switch (packet.t) {
						case GatewayDispatchEvents.Resumed:
							{
								this.offlineSendQueue.map((resolve: () => unknown) => resolve());
								this.options.handlePayload(this.id, packet);
							}
							break;
						case GatewayDispatchEvents.Ready: {
							this.data.resume_gateway_url = packet.d.resume_gateway_url;
							this.data.session_id = packet.d.session_id;
							this.offlineSendQueue.map((resolve: () => unknown) => resolve());
							this.options.handlePayload(this.id, packet);
							break;
						}
						default:
							this.options.handlePayload(this.id, packet);
							break;
					}
				}
				break;
		}
	}

	protected async handleClosed(close: { code: number; reason: string }): Promise<void> {
		clearInterval(this.heart.nodeInterval);
		this.logger?.warn(
			`${ShardSocketCloseCodes[close.code] ?? GatewayCloseCodes[close.code] ?? close.code} (${close.code})`,
			close.reason,
		);

		switch (close.code) {
			case ShardSocketCloseCodes.Shutdown:
				break;
			case 1000:
			case GatewayCloseCodes.UnknownOpcode:
			case GatewayCloseCodes.InvalidSeq:
			case GatewayCloseCodes.SessionTimedOut:
				{
					this.data.resume_seq = 0;
					this.data.session_id = undefined;
					this.data.resume_gateway_url = undefined;
					await this.reconnect();
				}
				break;
			case 1001:
			case 1006:
			case ShardSocketCloseCodes.ZombiedConnection:
			case GatewayCloseCodes.UnknownError:
			case GatewayCloseCodes.DecodeError:
			case GatewayCloseCodes.NotAuthenticated:
			case GatewayCloseCodes.AlreadyAuthenticated:
			case GatewayCloseCodes.RateLimited:
				{
					this.logger?.inform("Trying to reconnect");
					await this.reconnect();
				}
				break;
			case GatewayCloseCodes.AuthenticationFailed:
			case GatewayCloseCodes.DisallowedIntents:
			case GatewayCloseCodes.InvalidAPIVersion:
			case GatewayCloseCodes.InvalidIntents:
			case GatewayCloseCodes.InvalidShard:
			case GatewayCloseCodes.ShardingRequired:
				this.logger?.throw("Cannot reconnect");
				break;
			default:
				{
					this.logger?.warn("Unknown close code, trying to reconnect anyways");
					await this.reconnect();
				}
				break;
		}
	}

	public close(code: number, reason: string): void {
		clearInterval(this.heart.nodeInterval);
		if (!this.isOpen) {
			this.logger?.warn(`[Shard #${this.id}] Is not open, reason:`, reason);
			return;
		}
		this.logger?.debug(`[Shard #${this.id}] Called close with reason:`, reason);
		this.websocket?.close(code, reason);
	}

	protected handleMessage(data: string | Buffer): Promise<void> | undefined {
		let packet: GatewayDispatchPayload;
		try {
			if (data instanceof Buffer) {
				// biome-ignore lint/style/noParameterAssign:
				data = inflateSync(data);
			}
			packet = JSON.parse(data as string);
		} catch (e) {
			this.logger?.throw(`${e}`);
			return;
		}
		return this.onpacket(packet);
	}

	public checkOffline(force: boolean): Promise<unknown> {
		if (!this.isOpen) {
			return new Promise((resolve) => this.offlineSendQueue[force ? "unshift" : "push"](resolve));
		}
		return Promise.resolve();
	}

	public calculateSafeRequests(): number {
		const SAFE_REQUESTS =
			this.options.ratelimitOptions.maxRequestsPerRateLimitTick -
			Math.ceil(this.options.ratelimitOptions.rateLimitResetInterval / this.heart.interval) * 2;

		if (SAFE_REQUESTS < 0) {
			return 0;
		}
		return SAFE_REQUESTS;
	}
}
