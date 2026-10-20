import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  AUTH_VERIFIER_CAPABILITY,
  AuthEvents,
  OWNER_PRINCIPAL_ID,
  clientPrincipalId,
  type AuthVerifier,
  type Principal,
} from "@jhin/auth-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { UNGUARDED_STREAM_PERMISSION } from "@jhin/rpc";
import { definePlugin, holdsPermission, isGrant, z, type Invocation } from "@jhin/sdk";

import { ClientRecord, createClientStore } from "./clients.ts";

/** The single owner of a node (D22): every permission. */
const OWNER: Principal = { id: OWNER_PRINCIPAL_ID, permissions: ["*"] };

/** T3's sessions last 30 days (security.md D411). */
const DEFAULT_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const Grants = z
  .array(z.string().refine(isGrant, "must be a permission, a pattern such as git.* or *"))
  .min(1);

const Client = ClientRecord.omit({ secretHash: true }).extend({
  /** The token the caller itself connected with. */
  current: z.boolean(),
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
    const dataDir = context.services
      .get<HostPaths>(HOST_PATHS_CAPABILITY)
      .dataDir(context.plugin.id);
    const file = Path.join(dataDir, "token");
    const clients = createClientStore(Path.join(dataDir, "clients.json"), (moved, error) =>
      context.log.error("device tokens unreadable; none are accepted until they are issued again", {
        moved,
        error,
      }),
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

    const verifier: AuthVerifier = {
      async verify(credentials) {
        const given = credentials.token;
        if (given === undefined || given.length < MIN_TOKEN_LENGTH) return undefined;
        if (sameToken(given, token)) return OWNER;
        const record = clients.verify(given, Date.now());
        return record === undefined
          ? undefined
          : {
              id: clientPrincipalId(record.id),
              permissions: record.permissions,
              ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
            };
      },
    };
    context.services.provide(AUTH_VERIFIER_CAPABILITY, verifier);

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
        // Transports drop connections opened with the old token.
        context.events.emit(AuthEvents.tokenRotated, {});
        return { token };
      },
    });

    const view = (record: ClientRecord, invocation: Invocation): z.input<typeof Client> => {
      const { secretHash: _secret, ...rest } = record;
      return { ...rest, current: invocation.caller?.id === clientPrincipalId(record.id) };
    };
    const revoke = (ids: readonly string[]) => {
      const gone = clients.remove(ids);
      for (const record of gone) {
        context.log.warn("device token revoked", { client: record.id, label: record.label });
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
        ttlDays: z.number().positive().nullable().optional(),
      }),
      output: z.object({ id: z.string(), token: z.string(), expiresAt: z.number().optional() }),
      permissions: ["auth.write"],
      handler: ({ label, permissions, ttlDays }, invocation) => {
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
        const { record, token: issued } = clients.issue({
          label,
          permissions,
          method: "issued",
          now,
          ...(days === null ? {} : { expiresAt: now + days * DAY_MS }),
        });
        context.log.warn("device token issued", { client: record.id, label, permissions });
        return {
          id: record.id,
          token: issued,
          ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        };
      },
    });
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
        if (clients.get(id) === undefined) {
          throw failure("CLIENT_NOT_FOUND", `No device token ${id}`, { id });
        }
        return { revoked: revoke([id]) };
      },
    });
    context.commands.register({
      name: "auth.clients.revoke-others",
      description: "Revokes every device token except the one the caller is connected with",
      input: z.object({}),
      output: z.object({ revoked: z.array(z.string()) }),
      permissions: ["auth.write"],
      handler: (_input, invocation) => ({
        revoked: revoke(
          clients
            .list()
            .filter((record) => invocation.caller?.id !== clientPrincipalId(record.id))
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
        permissions: z.array(z.object({ permission: z.string(), commands: z.array(z.string()) })),
      }),
      permissions: ["auth.read"],
      handler: () => {
        const needed = new Map<string, string[]>([[UNGUARDED_STREAM_PERMISSION, []]]);
        for (const command of context.commands.list()) {
          for (const permission of command.permissions) {
            needed.set(permission, [...(needed.get(permission) ?? []), command.name]);
          }
        }
        return {
          permissions: [...needed]
            .map(([permission, commands]) => ({ permission, commands }))
            .toSorted((a, b) => a.permission.localeCompare(b.permission)),
        };
      },
    });
  },
});
