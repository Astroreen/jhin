# Dev scripts

Scripts to run Jhin from a checkout with one command each; T3 Code's project
actions call them. They need only bash and curl: inside the devenv shell they
use its Node 24, elsewhere they download Node 24 into `~/.cache/jhin` and get
pnpm through corepack.

| Script      | What it does                                                                        |
| ----------- | ----------------------------------------------------------------------------------- |
| `setup.sh`  | `pnpm install`                                                                      |
| `serve.sh`  | builds the web client and runs `jhin serve --ui --watch` on `http://127.0.0.1:7777` |
| `dev.sh`    | headless node plus the Vite dev server with hot reload on `http://127.0.0.1:7780`   |
| `stop.sh`   | stops what `serve.sh` and `dev.sh` started                                          |
| `verify.sh` | `pnpm verify --affected` (`--all` for the full run)                                 |
| `e2e.sh`    | Playwright end-to-end tests                                                         |
| `reset.sh`  | deletes the dev home, so the next start is a fresh node                             |

The node runs in its own home, `.jhin-dev/home` (gitignored), never in
`~/.jhin`, and listens on 127.0.0.1 only. Its access token is random, made on
the first start; `serve.sh` and `dev.sh` print the URL to open with it:

    jhin: open http://127.0.0.1:7777/#token=…

The web client keeps the token in the page's storage, so after opening that
URL once, the plain `http://127.0.0.1:7777` (T3 Code's preview) stays
connected until `reset.sh` makes a new home.

Environment overrides: `JHIN_PORT` (node, default 7777; written into the dev
home's config when the home is created, a warning when it differs later),
`JHIN_WEB_PORT` (Vite, default 7780), `JHIN_NODE_VERSION` (the Node release
downloaded when none is on PATH), `JHIN_DEV_DIR`, `JHIN_DEV_HOME`.

`shellcheck scripts/t3/*.sh` is clean (config in `.shellcheckrc`).
