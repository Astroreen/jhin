# T119 manual screenshot checklist

Operator-run. This file lists one entry per screen id from the plan's §4.2
screen inventory (26 upstream routes). Screenshots are **not** captured by the
automated suite — the operator boots the full bundle, walks each route and
drops a PNG next to this file. Do not fake screenshots.

## Procedure

1. Boot the full plugin bundle (all 12 jars) in a throwaway `JHIN_HOME`:
   `scripts/qa/run-kernel.sh` with `--server.port=<port>`.
2. For each row below, open the screen in the Flutter client (or fetch
   `GET /ui/screen/<id>` with `X-Jhin-Client: api=3; version=0.3.0; schema=4; caps=sse`
   and render it), then capture a PNG into `screens/<file>`.
3. Tick the **checked** column (`[x]`) and record the capture date.
4. A row whose screen id is parameterised (`chat:<id>`, `draft:<id>`,
   `project:<key>`) uses a concrete fixture id; record the id used.

## Checklist

| # | Jhin screen id | upstream route | wiring | screenshot file | checked |
| --- | --- | --- | --- | --- | --- |
| 1 | — (shell chrome) | `__root.tsx` | real | `01-shell-chrome.png` | [ ] |
| 2 | `shell` | `_chat.tsx` | real | `02-shell.png` | [ ] |
| 3 | `chat:new` | `_chat.index.tsx` | real | `03-chat-new.png` | [ ] |
| 4 | `chat:<id>` | `_chat.$environmentId.$threadId.tsx` | real | `04-chat-thread.png` | [ ] |
| 5 | `draft:<id>` | `_chat.draft.$draftId.tsx` | decorative | `05-draft.png` | [ ] |
| 6 | `pull-requests` | `_chat.pull-requests.tsx` | decorative | `06-pull-requests.png` | [ ] |
| 7 | `connect` | `connect.tsx` | decorative | `07-connect.png` | [ ] |
| 8 | `pair` | `pair.tsx` | partly real | `08-pair.png` | [ ] |
| 9 | `project:<key>` | `projects.$projectKey.tsx` | decorative | `09-project.png` | [ ] |
| 10 | `usage` | `usage.tsx` | decorative | `10-usage.png` | [ ] |
| 11 | `welcome` | `welcome.tsx` | decorative wizard | `11-welcome.png` | [ ] |
| 12 | `settings` | `settings.tsx` | real shell | `12-settings.png` | [ ] |
| 13 | `settings:general` | `settings.general.tsx` | partly real | `13-settings-general.png` | [ ] |
| 14 | `settings:appearance` | `settings.appearance.tsx` | real | `14-settings-appearance.png` | [ ] |
| 15 | `settings:keybindings` | `settings.keybindings.tsx` | real | `15-settings-keybindings.png` | [ ] |
| 16 | `settings:providers` | `settings.providers.tsx` | real | `16-settings-providers.png` | [ ] |
| 17 | `settings:connections` | `settings.connections.tsx` | decorative | `17-settings-connections.png` | [ ] |
| 18 | `settings:integrations` | `settings.integrations.tsx` | decorative | `18-settings-integrations.png` | [ ] |
| 19 | `settings:diagnostics` | `settings.diagnostics.tsx` | partly real | `19-settings-diagnostics.png` | [ ] |
| 20 | `settings:storage` | `settings.storage.tsx` | partly real | `20-settings-storage.png` | [ ] |
| 21 | `settings:archived` | `settings.archived.tsx` | real | `21-settings-archived.png` | [ ] |
| 22 | `settings:projects` | `settings.projects.tsx` | decorative | `22-settings-projects.png` | [ ] |
| 23 | `settings:scheduled-tasks` | `settings.scheduled-tasks.tsx` | decorative | `23-settings-scheduled-tasks.png` | [ ] |
| 24 | `settings:source-control` | `settings.source-control.tsx` | decorative | `24-settings-source-control.png` | [ ] |
| 25 | `settings:snap-shot` | `settings.snap-shot.tsx` | decorative | `25-settings-snap-shot.png` | [ ] |
| 26 | `settings:licenses` | `settings.open-source-licenses.tsx` | real (static text) | `26-settings-licenses.png` | [ ] |

Total: 26 entries (25 Jhin screen ids plus the shell-chrome row).
