import * as Crypto from "node:crypto";

/** WebSocket tickets are `jht1.<id>.<secret>` (security.md D1367). */
export const TICKET_PREFIX = "jht1.";
/** How long a ticket is good for: Jhin mints one right before each connect. */
const TICKET_TTL_MS = 60_000;
/** Open tickets per device token; one minting more is refused until some are used or expire. */
const MAX_OPEN_PER_CLIENT = 16;

const hash = (secret: string) => Crypto.createHash("sha256").update(secret).digest("base64url");

interface Open {
  readonly clientId: string;
  readonly secretHash: string;
  readonly expiresAt: number;
}

/** One-time tickets, kept as hashes in the plugin's kernel-scoped state. */
export class TicketStore {
  readonly #open = new Map<string, Open>();

  #prune(now: number) {
    for (const [id, ticket] of this.#open) if (ticket.expiresAt <= now) this.#open.delete(id);
  }

  /** Whether device token `clientId` holds as many open tickets as it may. */
  full(clientId: string, now: number): boolean {
    this.#prune(now);
    let held = 0;
    for (const open of this.#open.values()) if (open.clientId === clientId) held += 1;
    return held >= MAX_OPEN_PER_CLIENT;
  }

  /** A ticket for device token `clientId`, or undefined when it holds too many open. */
  issue(clientId: string, now: number): { ticket: string; expiresAt: number } | undefined {
    if (this.full(clientId, now)) return undefined;
    const id = Crypto.randomBytes(9).toString("base64url");
    const secret = Crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + TICKET_TTL_MS;
    this.#open.set(id, { clientId, secretHash: hash(secret), expiresAt });
    return { ticket: `${TICKET_PREFIX}${id}.${secret}`, expiresAt };
  }

  /** The device token a ticket stands for; the ticket is spent whether it is valid or not. */
  redeem(ticket: string, now: number): string | undefined {
    if (!ticket.startsWith(TICKET_PREFIX)) return undefined;
    const rest = ticket.slice(TICKET_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot <= 0) return undefined;
    const id = rest.slice(0, dot);
    const open = this.#open.get(id);
    if (open === undefined) return undefined;
    this.#open.delete(id);
    const given = Buffer.from(hash(rest.slice(dot + 1)));
    const expected = Buffer.from(open.secretHash);
    if (given.length !== expected.length || !Crypto.timingSafeEqual(given, expected)) {
      return undefined;
    }
    return open.expiresAt > now ? open.clientId : undefined;
  }
}
