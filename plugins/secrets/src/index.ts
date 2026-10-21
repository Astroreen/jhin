/**
 * `jhin.secrets`: the node's secrets apart from its config files
 * (docs/plans/security.md, D1021–D1033). The store's shape follows T3 Code's
 * ServerSecretStore and SecretRequests (MIT, see THIRD_PARTY_NOTICES.md).
 */
import {
  HOST_IDENTITY_CAPABILITY,
  HOST_PATHS_CAPABILITY,
  type HostIdentity,
  type HostPaths,
} from "@jhin/host-api";
import { definePlugin, describePermissions, toDisposable, z } from "@jhin/sdk";
import {
  SECRETS_CONFIG_SECTION,
  SECRETS_STORE_CAPABILITY,
  SecretsStatus,
  type SecretStore,
} from "@jhin/secrets-api";

import { findKeychain } from "./keychain.ts";
import { openStore } from "./store.ts";

const Config = z
  .object({
    keychain: z.enum(["auto", "off"]).default("auto").meta({
      title: "Keychain",
      description:
        "Where the store's key is kept when the store is made: the OS keychain when the node finds one (auto), else a key file beside the store. An existing store keeps its key where it is.",
    }),
  })
  .meta({
    title: "Secrets",
    description: "Secrets kept apart from the config files, sealed with a key of their own.",
  });
type Config = z.output<typeof Config>;

/** How often expired secretRefs are removed (T3 sweeps every hour). */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export default definePlugin({
  async activate(context) {
    context.config.define(SECRETS_CONFIG_SECTION, Config);
    const paths = context.services.get<HostPaths>(HOST_PATHS_CAPABILITY);
    const { nodeId } = context.services.get<HostIdentity>(HOST_IDENTITY_CAPABILITY);
    const config = context.config.get<Config>(SECRETS_CONFIG_SECTION);
    const store = await openStore({
      dir: paths.dataDir(context.plugin.id),
      keychain: config.keychain === "off" ? undefined : findKeychain(`jhin.secrets:${nodeId}`),
    });
    if (!store.readable) {
      context.log.error(
        "secret store could not be opened: config secrets do not resolve and nothing is saved",
        { key: store.status().key },
      );
    }
    const sweep = () => {
      try {
        const removed = store.sweep();
        if (removed > 0) context.log.info("expired secretRefs removed", { removed });
      } catch (error) {
        context.log.warn("could not remove expired secretRefs", { error: String(error) });
      }
    };
    sweep();
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    timer.unref?.();
    context.subscriptions.add(toDisposable(() => clearInterval(timer)));

    const capability: SecretStore = store;
    context.services.provide(SECRETS_STORE_CAPABILITY, capability);

    describePermissions(context, {
      "secrets.read": {
        title: "View the secret store",
        description: "See where secrets are kept and how many; never their values.",
      },
    });

    context.commands.register({
      name: "secrets.status",
      title: "Secret store status",
      description:
        "Where the node's secret store keeps its key (the OS keychain or a key file), whether it could be opened, and how many config secrets and unused secretRefs it holds. Never a value.",
      input: z.object({}),
      output: SecretsStatus,
      permissions: ["secrets.read"],
      handler: () => store.status(),
    });
  },
});
