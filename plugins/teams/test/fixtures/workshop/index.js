// A team bundle (docs/plans/agents.md#D686): it hands its folder (team.json,
// culture.md, lore/, agents/<member>/) to jhin.teams, and takes it back on unload.
import * as Path from "node:path";
import * as Url from "node:url";

export default {
  activate(context) {
    const root = Path.dirname(Url.fileURLToPath(import.meta.url));
    context.subscriptions.add(
      context.services.get("teams.bundles").register(root, context.plugin.id),
    );
  },
};
