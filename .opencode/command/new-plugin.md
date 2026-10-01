---
description: Scaffold and implement a Jhin plugin from a plain-language idea
---
Scaffold a new Jhin plugin from the idea in: $ARGUMENTS

Read `.opencode/skill/jhin-plugin/SKILL.md` first — it is the checklist of
record — and work through it end to end:

1. Run the skill's 6-question intake on the idea. Ask the user only for what
   the idea does not determine (id, display name, surfaces, plugin
   dependencies, storage, UI).
2. Fill the skill's naming table, then render `.opencode/skill/jhin-plugin/template/**`
   into `plugins/<module>/`: substitute `__PLUGIN_ID__`, `__PLUGIN_NAME__` and
   `__PKG__`, expand the `__PKG__` directory into the dotted package path and
   rename the `__PLUGIN_NAME__` files, exactly as the render recipe states.
3. Wire the module into the root `settings.gradle`:
   `includeBuild('plugins/<module>') { name = 'jhin-plugin-<module>' }`.
4. Build and test: `./gradlew :jhin-plugin-<module>:test :jhin-plugin-<module>:jar`.
   A happy AND a failure test must pass before anything is declared done.
5. Install and verify as the skill's install-and-verify section says: copy the
   jar into `$JHIN_HOME/plugins/`, restart the host and `curl` the route with
   `--max-time`, then check `/_jhin/health` lists the plugin.

Obey every hard rule in the skill: never touch the kernel, never import a
non-exported package, always prefix tables with the plugin prefix, comments in
English, happy + failure tests before done.
