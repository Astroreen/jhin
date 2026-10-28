import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  AUTH_VERIFIER_CAPABILITY,
  AuthEvents,
  OWNER_PRINCIPAL_ID,
  clientPrincipalId,
  isPlainHttpUrl,
  type AuthVerifier,
  type Principal,
} from "@jhin/auth-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import { UNGUARDED_STREAM_PERMISSION } from "@jhin/rpc";
import {
  PERMISSIONS_DESCRIBE_HOOK,
  definePlugin,
  describePermissions,
  holdsPermission,
  isGrant,
  z,
  type Invocation,
  type PermissionDescription,
  type PermissionEntry,
} from "@jhin/sdk";

import { ClientRecord, createClientStore } from "./clients.ts";
import { ReplayGuard } from "./dpop.ts";
import { serveAuthHttp } from "./http.ts";
import { ClientMetadata } from "./metadata.ts";
import { createPairingStore, type PairingStore } from "./pairing.ts";
import { TICKET_PREFIX, TicketStore } from "./tickets.ts";

/** The single owner of a node (D22): every permission. */
const OWNER: Principal = { id: OWNER_PRINCIPAL_ID, permissions: ["*"] };

/** T3's sessions last 30 days (security.md D411). */
const DEFAULT_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** T3's pairing tokens last 5 minutes by default (security.md D419). */
const DEFAULT_PAIRING_MINUTES = 5;
const MAX_PAIRING_MINUTES = 24 * 60;
/** The longest a token may be issued for; `null` asks for one that never expires. */
const MAX_TTL_DAYS = 3650;

const Grants = z
  .array(z.string().refine(isGrant, "must be a permission, a pattern such as git.* or *"))
  .min(1);

/** An http(s) address, perhaps under a path; never credentials, a query or a fragment. */
const PlainUrl = z
  .string()
  .refine(isPlainHttpUrl, "must be an http(s) address, without credentials, query or fragment");

const CONFIG_SECTION = "jhin.auth-token";
const AuthConfig = z
  .object({
    clientUrl: PlainUrl.optional().meta({
      title: "Client page address",
      description:
        "Where a jhin client page is served, e.g. https://jhin.example.com. Pairing links then also open there and pair with this node.",
      advanced: true,
    }),
  })
  .default({})
  .meta({ title: "Pairing", description: "How other devices pair with this node." });

const Client = ClientRecord.omit({ secretHash: true, jkt: true }).extend({
  /** The token the caller itself connected with. */
  current: z.boolean(),
  /** Bound to a key of its device: used only with a DPoP proof (security.md D1366). */
  bound: z.boolean().optional(),
});

function failure(code: string, message: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, details });
}

/** Grants the caller cannot give, because it does not hold them (security.md D413). */
function notHeld(invocation: Invocation, grants: readonly string[]): string[] {
  const caller = invocation.caller;
  if (caller === undefined) return [];
  return grants.filter((grant) => !holdsPermission(caller.permissions, grant));
}

/** What `clientPrincipalId` puts before a device token's id. */
const CLIENT_PRINCIPAL_PREFIX = clientPrincipalId("");

/** 32 random bytes in base64url are 43 characters; anything shorter is not a token we made. */
const MIN_TOKEN_LENGTH = 43;

const newToken = () => Crypto.randomBytes(32).toString("base64url");

function writeToken(file: string, token: string): void {
  Fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  Fs.chmodSync(file, 0o600);
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && Crypto.timingSafeEqual(a, b);
}

export default definePlugin({
  activate(context) {
    context.config.define(CONFIG_SECTION, AuthConfig);
    const dataDir = context.services
      .get<HostPaths>(HOST_PATHS_CAPABILITY)
      .dataDir(context.plugin.id);
    const file = Path.join(dataDir, "token");
    // Warned once, with what was kept (security.md D1518).
    const clients = createClientStore(
      Path.join(dataDir, "clients.json"),
      ({ moved, error, kept, unreadable, expired, failed }) =>
        failed === undefined
          ? context.log.warn(
              `device tokens were unreadable; repaired from the file itself: kept ${kept}, could not read ${unreadable}`,
              { moved, error, kept, unreadable, expired },
            )
          : context.log.warn(
              "device tokens unreadable and the repair could not be written; none are accepted until they are issued again",
              { moved, error, failed, unreadable, expired },
            ),
    );
    const existing = Fs.existsSync(file) ? Fs.readFileSync(file, "utf8").trim() : "";
    let token: string;
    if (existing.length >= MIN_TOKEN_LENGTH) {
      token = existing;
    } else {
      // A missing, empty or truncated file never becomes a guessable token.
      token = newToken();
      writeToken(file, token);
      // Printed once, when created; afterwards `jhin auth.token.show` prints it.
      process.stderr.write(
        `jhin: created the access token for this node: ${token}\n      (stored in ${file})\n`,
      );
      context.log.warn("access token created", { file, replacedInvalid: existing.length > 0 });
    }

    // Open WebSocket tickets outlive a reload of this plugin, not a restart (D1367).
    const tickets =
      context.state.get<TicketStore>("tickets") ??
      (() => {
        const created = new TicketStore();
        context.state.set("tickets", created);
        return created;
      })();
    const principalOf = (record: ClientRecord): Principal => ({
      id: clientPrincipalId(record.id),
      permissions: record.permissions,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    });
    const verifier: AuthVerifier = {
      async verify(credentials) {
        const given = credentials.token;
        if (given === undefined || given.length < MIN_TOKEN_LENGTH) return undefined;
        if (sameToken(given, token)) return OWNER;
        const now = Date.now();
        // A ticket stands for its device token once (security.md D1367).
        if (given.startsWith(TICKET_PREFIX)) {
          const id = tickets.redeem(given, now);
          const record = id === undefined ? undefined : clients.get(id);
          if (record === undefined) return undefined;
          if (record.expiresAt !== undefined && record.expiresAt <= now) return undefined;
          return principalOf(record);
        }
        const record = clients.verify(given, now);
        // A bound token is never accepted alone: only with a proof, for a ticket (D1366).
        return record === undefined || record.jkt !== undefined
          ? undefined
          : {
              id: clientPrincipalId(record.id),
              permissions: record.permissions,
              ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
            };
      },
    };
    context.services.provide(AUTH_VERIFIER_CAPABILITY, verifier);
    /** Tells the transports the list of clients changed (security.md D1188). */
    const changed = () => context.events.emit(AuthEvents.clientsChanged, {});
    // T3's "View access" and "Manage access" (security.md D961).
    describePermissions(context, {
      "auth.read": {
        title: "View access",
        description: "Inspect pairing links and authorized clients.",
      },
      "auth.write": {
        title: "Manage access",
        description: "Issue and revoke credentials for other clients.",
      },
      "auth.admin": {
        title: "Manage the owner token",
        description: "Show and rotate this node's access token.",
      },
      [UNGUARDED_STREAM_PERMISSION]: {
        title: "Read event streams",
        description: "Subscribe to event streams no other permission guards.",
      },
    });

    context.commands.register({
      name: "auth.token.show",
      description: "Prints this node's access token",
      input: z.object({}),
      output: z.object({ token: z.string(), file: z.string() }),
      permissions: ["auth.admin"],
      handler: () => ({ token, file }),
    });
    context.commands.register({
      name: "auth.token.rotate",
      description:
        "Replaces the access token; open connections are dropped and must reconnect with the new one",
      input: z.object({}),
      output: z.object({ token: z.string() }),
      permissions: ["auth.admin"],
      handler: () => {
        token = newToken();
        writeToken(file, token);
        context.log.warn("access token rotated", { file });
        // Codes and page sessions made with the old owner token end with it.
        pairing.revokeBy(OWNER_PRINCIPAL_ID);
        changed();
        revoke(
          clients
            .list()
            .filter((record) => record.parent === OWNER_PRINCIPAL_ID)
            .map((record) => record.id),
        );
        // Transports drop connections opened with the old token.
        context.events.emit(AuthEvents.tokenRotated, {});
        return { token };
      },
    });

    const view = (record: ClientRecord, invocation: Invocation): z.input<typeof Client> => {
      const { secretHash: _secret, jkt, ...rest } = record;
      return {
        ...rest,
        current: invocation.caller?.id === clientPrincipalId(record.id),
        ...(jkt === undefined ? {} : { bound: true }),
      };
    };
    /** The device token of this node a principal is, if it is one. */
    const recordOf = (principal: string): ClientRecord | undefined =>
      principal.startsWith(CLIENT_PRINCIPAL_PREFIX)
        ? clients.get(principal.slice(CLIENT_PRINCIPAL_PREFIX.length))
        : undefined;
    /**
     * The device token a caller stands on (security.md D1703): its own, or the
     * first of its parents that has none, as a page session stands on the token
     * that opened it (D421). None for the owner, a page session the owner
     * opened, and a caller that is no device token of this node. The same walk
     * as `jhin.mcp-oauth`'s `standingOf`, which answers the owner itself.
     */
    const standingOf = (principal: string | undefined): ClientRecord | undefined => {
      let record = principal === undefined ? undefined : recordOf(principal);
      const longest = clients.list().length;
      for (let hops = 0; record?.parent !== undefined; hops++) {
        if (record.parent === OWNER_PRINCIPAL_ID) return undefined;
        const parent = recordOf(record.parent);
        // A parent that is gone was revoked, and this record goes with it (its
        // revoke cascades): what it issues stands on it and goes too. A cycle
        // is no file this plugin wrote; the walk stops there.
        if (parent === undefined || hops > longest) return record;
        record = parent;
      }
      return record;
    };
    const revoke = (ids: readonly string[]) => {
      // A page session opened with a revoked token goes with it, and so on down.
      const doomed = new Set(ids);
      for (let grew = true; grew;) {
        grew = false;
        for (const record of clients.list()) {
          const parent = record.parent;
          if (doomed.has(record.id) || parent === undefined) continue;
          if ([...doomed].some((id) => clientPrincipalId(id) === parent)) {
            doomed.add(record.id);
            grew = true;
          }
        }
      }
      const gone = clients.remove([...doomed]);
      if (gone.length > 0) changed();
      for (const record of gone) {
        context.log.warn("device token revoked", { client: record.id, label: record.label });
        // Codes it made end with it: they carry its grants.
        pairing.revokeBy(clientPrincipalId(record.id));
        // Transports drop its open connections at once (security.md D414).
        context.events.emit(AuthEvents.clientRevoked, { principal: clientPrincipalId(record.id) });
      }
      return gone.map((record) => record.id);
    };

    context.commands.register({
      name: "auth.tokens.issue",
      description:
        "Issues a scoped bearer access token for headless or remote clients; it is shown only once",
      input: z.object({
        label: z.string().trim().min(1),
        permissions: Grants,
        /** Days until it stops working; `null` never. Defaults to 30. */
        ttlDays: z.number().positive().max(MAX_TTL_DAYS).nullable().optional(),
        /** `oauth`: issued to an MCP client its owner approved (security.md D1195). */
        method: z.enum(["issued", "oauth"]).optional(),
        /** What the client said about itself (D1187). */
        metadata: ClientMetadata.optional(),
      }),
      output: z.object({ id: z.string(), token: z.string(), expiresAt: z.number().optional() }),
      permissions: ["auth.write"],
      handler: ({ label, permissions, ttlDays, method, metadata }, invocation) => {
        const missing = notHeld(invocation, permissions);
        if (missing.length > 0) {
          throw failure(
            "PERMISSION_NOT_HELD",
            `A token cannot get ${missing.join(", ")}: the caller does not hold it`,
            { missing },
          );
        }
        const now = Date.now();
        const days = ttlDays === undefined ? DEFAULT_TTL_DAYS : ttlDays;
        const asked = days === null ? undefined : Math.ceil(now + days * DAY_MS);
        // Revoked with the device its caller stands on, and never outliving it (D1703).
        const issuer = standingOf(invocation.caller?.id);
        const expiresAt =
          issuer?.expiresAt === undefined
            ? asked
            : Math.min(asked ?? Number.POSITIVE_INFINITY, issuer.expiresAt);
        const { record, token: issued } = clients.issue({
          label,
          permissions,
          method: method ?? "issued",
          now,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(issuer === undefined ? {} : { parent: clientPrincipalId(issuer.id) }),
          ...(metadata === undefined ? {} : { metadata }),
        });
        context.log.warn("device token issued", {
          client: record.id,
          label,
          permissions,
          method: record.method,
        });
        changed();
        return {
          id: record.id,
          token: issued,
          ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        };
      },
    });
    /**
     * A device token for a code that was just used up (D420; its label wins,
     * as in T3), or for a token traded for the page's session (D421): that
     * one is `issued` and never outlives the token it came from.
     */
    const issuePaired = (
      permissions: readonly string[],
      label: string,
      from?: { readonly id: string; readonly expiresAt?: number },
      metadata?: ClientMetadata,
      jkt?: string,
    ) => {
      const now = Date.now();
      const longest = now + DEFAULT_TTL_DAYS * DAY_MS;
      const { record, token: issued } = clients.issue({
        label,
        permissions,
        method: from === undefined ? "pairing" : "issued",
        now,
        expiresAt: from?.expiresAt === undefined ? longest : Math.min(longest, from.expiresAt),
        ...(from === undefined ? {} : { parent: from.id }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(jkt === undefined ? {} : { jkt }),
      });
      changed();
      if (from === undefined) {
        context.log.warn("device paired", { client: record.id, label, permissions });
      } else {
        context.log.info("page session opened", { client: record.id, permissions });
      }
      return {
        id: record.id,
        token: issued,
        permissions: record.permissions,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        tokenType: jkt === undefined ? ("Bearer" as const) : ("DPoP" as const),
      };
    };
    // Open codes outlive a reload of this plugin, not a restart of the node.
    const pairing =
      context.state.get<PairingStore>("pairing") ??
      (() => {
        const created = createPairingStore();
        context.state.set("pairing", created);
        return created;
      })();
    const http = context.services.tryGet<HttpServer>(HTTP_SERVER_CAPABILITY);
    const PairingLink = z.object({
      id: z.string(),
      label: z.string().optional(),
      permissions: z.array(z.string()),
      createdAt: z.number(),
      expiresAt: z.number(),
    });

    context.commands.register({
      name: "auth.pairing.create",
      description:
        "A one-time pairing code and link another device uses to pair with this node as an authorized client",
      input: z.object({
        label: z.string().trim().min(1).optional(),
        /** Defaults to every grant the caller holds. */
        permissions: Grants.optional(),
        ttlMinutes: z.number().positive().max(MAX_PAIRING_MINUTES).optional(),
        /** Where the device reaches this node, e.g. https://jhin.example.com; defaults to its HTTP address. */
        baseUrl: PlainUrl.optional(),
        /**
         * Where a `jhin client` page is served (security.md D1190); defaults to
         * `jhin.auth-token.clientUrl`. Adds `clientLink`, T3's hosted link.
         */
        clientUrl: PlainUrl.optional(),
      }),
      output: PairingLink.extend({
        code: z.string(),
        url: z.string().optional(),
        clientLink: z.string().optional(),
      }),
      permissions: ["auth.write"],
      handler: ({ label, permissions, ttlMinutes, baseUrl, clientUrl }, invocation) => {
        const granted = permissions ?? [...(invocation.caller?.permissions ?? ["*"])];
        const missing = notHeld(invocation, granted);
        if (missing.length > 0) {
          throw failure(
            "PERMISSION_NOT_HELD",
            `A pairing code cannot give ${missing.join(", ")}: the caller does not hold it`,
            { missing },
          );
        }
        const now = Date.now();
        const { link, code } = pairing.create({
          ...(label === undefined ? {} : { label }),
          ...(invocation.caller === undefined ? {} : { creator: invocation.caller.id }),
          permissions: granted,
          now,
          expiresAt: now + (ttlMinutes ?? DEFAULT_PAIRING_MINUTES) * 60_000,
        });
        const base = (baseUrl ?? http?.url)?.replace(/\/+$/, "");
        const client = (
          clientUrl ?? context.config.get<z.output<typeof AuthConfig>>(CONFIG_SECTION).clientUrl
        )?.replace(/\/+$/, "");
        context.log.warn("pairing code created", { link: link.id, label, permissions: granted });
        changed();
        // T3's `buildHostedPairingUrl`: the node in the query, the code in the fragment (D1190).
        const query = new URLSearchParams(base === undefined ? [] : [["host", base]]);
        if (label !== undefined) query.set("label", label);
        return {
          ...link,
          permissions: [...link.permissions],
          code,
          // The code rides in the fragment, which never reaches a server (D422).
          ...(base === undefined ? {} : { url: `${base}/pair#token=${code}` }),
          ...(client === undefined || base === undefined
            ? {}
            : { clientLink: `${client}/pair?${query.toString()}#token=${code}` }),
        };
      },
    });
    context.commands.register({
      name: "auth.pairing.list",
      description: "Pairing codes not used and not expired yet, without the codes",
      input: z.object({}),
      output: z.object({ links: z.array(PairingLink) }),
      permissions: ["auth.read"],
      handler: () => ({
        links: pairing
          .list(Date.now())
          .map((link) => ({ ...link, permissions: [...link.permissions] })),
      }),
    });
    context.commands.register({
      name: "auth.pairing.revoke",
      description: "Ends a pairing code before it is used",
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ revoked: z.boolean() }),
      permissions: ["auth.write"],
      handler: ({ id }) => {
        const revoked = pairing.revoke(id);
        if (revoked) changed();
        return { revoked };
      },
    });

    if (http !== undefined) {
      context.subscriptions.add(
        serveAuthHttp({
          http,
          log: context.log,
          attempts:
            context.state.get<Map<string, number>>("attempts") ??
            (() => {
              const created = new Map<string, number>();
              context.state.set("attempts", created);
              return created;
            })(),
          pair(code, label, metadata, jkt) {
            return pairing.redeem(code, Date.now(), (link) =>
              issuePaired(
                link.permissions,
                link.label ?? label ?? "Paired device",
                undefined,
                metadata,
                jkt,
              ),
            );
          },
          replay:
            context.state.get<ReplayGuard>("dpop") ??
            (() => {
              const created = new ReplayGuard();
              context.state.set("dpop", created);
              return created;
            })(),
          ticket(given) {
            // The token itself, with its key's thumbprint when it is bound (D1367).
            const record = clients.verify(given, Date.now());
            if (record === undefined) return undefined;
            return {
              ...(record.jkt === undefined ? {} : { jkt: record.jkt }),
              full: () => tickets.full(record.id, Date.now()),
              issue: () => tickets.issue(record.id, Date.now()),
            };
          },
          async openSession(credential, metadata) {
            // A ticket is for one socket (D1367), never a standing page session.
            if (credential.startsWith(TICKET_PREFIX)) return undefined;
            const paired = pairing.redeem(credential, Date.now(), (link) =>
              issuePaired(link.permissions, link.label ?? "Browser", undefined, metadata),
            );
            if (paired !== undefined) return paired;
            // A token (e.g. the owner's from `#token=`) opens a session with its own grants.
            const principal = await verifier.verify({ token: credential });
            return principal === undefined
              ? undefined
              : issuePaired(principal.permissions, "Browser", principal, metadata);
          },
          verify: (given) => verifier.verify({ token: given }),
          closeSession(given) {
            const record = clients.verify(given, Date.now());
            if (record !== undefined) revoke([record.id]);
          },
        }),
      );
    }

    context.commands.register({
      name: "auth.clients.list",
      description:
        "Device tokens of this node (paired devices and issued tokens), without their secrets",
      input: z.object({}),
      output: z.object({ clients: z.array(Client) }),
      permissions: ["auth.read"],
      handler: (_input, invocation) => ({
        clients: clients.list().map((record) => view(record, invocation)),
      }),
    });
    context.commands.register({
      name: "auth.clients.revoke",
      description: "Revokes a device token; its open connections are dropped at once",
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ revoked: z.array(z.string()) }),
      permissions: ["auth.write"],
      handler: ({ id }, invocation) => {
        if (invocation.caller?.id === clientPrincipalId(id)) {
          throw failure(
            "CURRENT_CLIENT_REVOKE_NOT_ALLOWED",
            "A client cannot revoke the token it is connected with",
          );
        }
        const record = clients.get(id);
        if (record === undefined) {
          throw failure("CLIENT_NOT_FOUND", `No device token ${id}`, { id });
        }
        const missing = notHeld(invocation, record.permissions);
        if (missing.length > 0) {
          throw failure(
            "PERMISSION_NOT_HELD",
            `Revoking ${id} needs ${missing.join(", ")}: a caller only revokes tokens it could have issued`,
            { id, missing },
          );
        }
        return { revoked: revoke([id]) };
      },
    });
    context.commands.register({
      name: "auth.clients.revoke-others",
      description:
        "Revokes every device token except the one the caller is connected with, and those holding grants the caller does not",
      input: z.object({}),
      output: z.object({ revoked: z.array(z.string()) }),
      permissions: ["auth.write"],
      handler: (_input, invocation) => ({
        revoked: revoke(
          clients
            .list()
            .filter((record) => invocation.caller?.id !== clientPrincipalId(record.id))
            // A caller only revokes what it could have issued (security.md D413).
            .filter((record) => notHeld(invocation, record.permissions).length === 0)
            .map((record) => record.id),
        ),
      }),
    });
    context.commands.register({
      name: "auth.permissions.list",
      description:
        "Every permission this node's commands need, with the commands that need it, to grant to a token",
      input: z.object({}),
      output: z.object({
        permissions: z.array(
          z.object({
            permission: z.string(),
            commands: z.array(z.string()),
            title: z.string().min(1).optional(),
            description: z.string().min(1).optional(),
            /** Runs commands on this machine as the node's user (security.md D1364). */
            shellAccess: z.boolean().optional(),
            /** Since security.md D1517: why it reaches the node's user, for "Shell access: <reason>." */
            shellAccessReason: z.string().min(1).optional(),
            /** The streams a subscriber needs it for (security.md D1371). */
            streams: z.array(z.string()).optional(),
          }),
        ),
      }),
      permissions: ["auth.read"],
      handler: async () => {
        const needed = new Map<string, string[]>([[UNGUARDED_STREAM_PERMISSION, []]]);
        for (const command of context.commands.list()) {
          for (const permission of command.permissions) {
            needed.set(permission, [...(needed.get(permission) ?? []), command.name]);
          }
        }
        const entries: PermissionEntry[] = [...needed]
          .map(([permission, commands]) => ({ permission, commands }))
          .toSorted((a, b) => a.permission.localeCompare(b.permission));
        // Each plugin titles the permissions its commands need (security.md D961).
        // A hook that throws or answers something else costs the titles, not
        // the list (D961): only string titles and descriptions are read from
        // its answer, by permission, onto this node's own entries.
        const titles = new Map<string, PermissionDescription>();
        // The streams each permission guards, as the transport says (security.md D1371);
        // a permission only a stream needs is listed with no commands. Only names are taken.
        const guarded = new Map<string, string[]>();
        try {
          const output = await context.hooks.run<object, unknown>(
            PERMISSIONS_DESCRIBE_HOOK,
            {},
            () => entries,
          );
          for (const item of Array.isArray(output) ? (output as unknown[]) : []) {
            const { permission, title, description, shellAccess, shellAccessReason, streams } =
              (item ?? {}) as Record<string, unknown>;
            if (typeof permission !== "string") continue;
            // Names only, non-empty, and a bounded few: a hook offers names, nothing more.
            const named = Array.isArray(streams)
              ? streams
                  .filter((stream): stream is string => typeof stream === "string" && stream !== "")
                  .slice(0, 100)
              : [];
            const plain = permission !== "*" && !permission.endsWith(".*") && isGrant(permission);
            // Two items for one permission add up, as two hooks may each name streams.
            if (named.length > 0 && plain) {
              guarded.set(permission, [...(guarded.get(permission) ?? []), ...named].slice(0, 100));
            }
            if (typeof title !== "string" || title === "") continue;
            titles.set(permission, {
              title,
              ...(typeof description === "string" && description !== "" ? { description } : {}),
              ...(shellAccess === true ? { shellAccess } : {}),
              // A reason only with shell access, and short: it ends a sentence the UI shows.
              ...(shellAccess === true &&
              typeof shellAccessReason === "string" &&
              shellAccessReason.trim() !== ""
                ? { shellAccessReason: shellAccessReason.trim().slice(0, 200) }
                : {}),
            });
          }
        } catch (error) {
          context.log.error("a permission description hook failed; listing without titles", {
            error: String(error),
          });
        }
        const only = [...guarded.keys()]
          .filter((permission) => !needed.has(permission))
          .map((permission): PermissionEntry => ({ permission, commands: [] }));
        return {
          permissions: [...entries, ...only]
            .toSorted((a, b) => a.permission.localeCompare(b.permission))
            .map((entry) => {
              const streams = guarded.get(entry.permission);
              return {
                ...entry,
                ...titles.get(entry.permission),
                ...(streams === undefined ? {} : { streams: [...new Set(streams)] }),
              };
            }),
        };
      },
    });
  },
});
