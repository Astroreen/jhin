# Third-party notices

Jhin is licensed under Apache-2.0 (see `LICENSE`). Parts of it are derived
from the projects below; their notices are reproduced as their licenses
require.

## T3 Code

Source: https://github.com/pingdotgg/t3code

Used for: the web client's visual layer (components, layout, styles) and
parts of its logic (keybindings, command palette search, work-log summaries,
prompt history, timestamps, thread status, settings forms, the sidebar's
thread order, settling, pinning, snoozing and dragging, with the threads
plugin's rules for them, the thread cards' branch, pull request and diff
indicators, the branch toolbar and the diff panel, the terminal drawer, its
tabs and splits and the terminal indicator of a thread's card, node machine
icons), source control (`plugins/source-control`: reading git status and
diffs, pull requests and their checks through the GitHub CLI), the detection
of a node's machine kind (`packages/node-host/src/machine.ts`), the Claude
Code agent runtime (`plugins/agent-claude`: query options, permission modes,
tool, question and plan mapping, result errors, the model catalog, live
sessions kept between turns, the node's MCP server attached to Claude Code),
the agent credentials of the MCP server plugin (`plugins/mcp-server`) and the
terminal plugin (`plugins/terminal`:
loading node-pty, the shell's environment, sizes, scrollback and finding the
program a terminal runs). Files derived from T3 Code say so in a header
comment.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
