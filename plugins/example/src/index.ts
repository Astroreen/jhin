import { definePlugin, z } from "@jhin/sdk";

/** What this plugin provides as `example.greeter@1`; other plugins depend on the capability, not on this plugin. */
export interface Greeter {
  greet(name: string): string;
}

const Config = z.object({
  greeting: z.string().default("Hello"),
});

export default definePlugin({
  activate(context) {
    // Config: the "jhin.example" section of any config layer.
    context.config.define("jhin.example", Config);

    // Service: the implementation of the capability declared in "provides".
    const greeter: Greeter = {
      greet: (name) =>
        `${context.config.get<z.output<typeof Config>>("jhin.example").greeting}, ${name}!`,
    };
    context.services.provide("example.greeter", greeter);

    // Command: reachable from RPC, the CLI (`jhin example.greet --name Ada`) and MCP.
    context.commands.register({
      name: "example.greet",
      description: "Greets someone",
      input: z.object({ name: z.string().min(1) }),
      output: z.object({ message: z.string(), count: z.number() }),
      // Hook: other plugins can change the input, wrap or change the result of "example.greet".
      handler: (input) =>
        context.hooks.run("example.greet", input, ({ name }) => {
          // State: survives a reload of this plugin.
          const count = (context.state.get<number>("count") ?? 0) + 1;
          context.state.set("count", count);
          context.events.emit("example.greeted", { name, count });
          return { message: greeter.greet(name), count };
        }),
    });

    context.log.info("example plugin ready");
  },
});
