# Dev scripts

Scripts to run Jhin from a checkout with one command each; T3 Code's project
actions call them. They need only bash and curl: inside the devenv shell they
use its Node 24, elsewhere they download Node 24 into `~/.cache/jhin` and get
pnpm through corepack.

| Script      | What it does                                                                        |
| ----------- | ----------------------------------------------------------------------------------- |
| `setup.sh`  | `pnpm install`                                                                      |
| `serve.sh`  | builds the web client and runs `jhin serve --ui --watch` on `http://127.0.0.1:7777` |
| `dev.sh`    | headless node plus the Vite dev server with hot reload on `http://127.0.0.1:5180`   |
| `stop.sh`   | stops what `serve.sh` and `dev.sh` started                                          |
| `verify.sh` | `pnpm verify --affected` (`--all` for the full run)                                 |
| `e2e.sh`    | Playwright end-to-end tests                                                         |
| `reset.sh`  | deletes the dev home, so the next start is a fresh node                             |

The node runs in its own home, `.jhin-dev/home` (gitignored), never in
`~/.jhin`. That home gets a fixed access token so a preview URL can carry it:

    http://127.0.0.1:7777/#token=jhin-local-dev-token-for-127-0-0-1-only-000

The node listens on 127.0.0.1 only; do not expose the dev home to other
machines.

Environment overrides: `JHIN_PORT` (node, default 7777; read when the dev
home is created), `JHIN_WEB_PORT` (Vite, default 5180), `JHIN_DEV_DIR`,
`JHIN_DEV_HOME`, `JHIN_DEV_TOKEN`.
