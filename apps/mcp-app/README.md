# tldraw MCP app

This is the tldraw MCP app. It exposes an interactive tldraw canvas to AI agents via the [Model Context Protocol app specification](https://github.com/modelcontextprotocol/ext-apps/), so you can work in tldraw with agents in any MCP client that supports the MCP app spec.

## Architecture

The app has two parts: a **server** and a **widget**.

### Server

The server runs in Cloudflare Workers via `src/worker.ts`, using a Durable Object (`TldrawMCP`) backed by SQLite for persistent checkpoint storage.

It exposes:

- `search` — query the extracted Editor API spec in a sandboxed dynamic worker
- `exec` — execute JavaScript against the live editor in the widget via a pending-request callback bridge
- `_exec_callback` — app-only tool the widget calls to resolve a pending `exec` request
- `save_checkpoint` / `read_checkpoint` — app-only tools used by the widget for checkpoint persistence
- `search_boards` / `read_board` — search and inspect named browser boards
- `set_board_shape_text` — persistently replace text on existing rectangles, text shapes or notes in saved boards without a live browser

Named browser boards use a separate `NamedBoardStore` Durable Object. They remain available after the browser closes and do not expire with an MCP session.

### Widget

The widget is a React app (`src/widget/mcp-app.tsx`) that renders a full tldraw canvas inside the MCP host's iframe.

When the AI calls `exec`, the server creates a pending request and the widget picks it up, runs the code through a focused editor proxy (`src/widget/focused/`) that translates between an AI-friendly shape format (simple string IDs, flat `_type` shapes) and tldraw's internal `TLShape`/`TLShapeId` types, then calls `_exec_callback` to resolve the pending request with the result. Canvas state is checkpointed to the Durable Object's SQLite database and to the browser's local storage.

## Named browser boards

Open the examples app's `/boards` page to draw normally, save a document with a name, and later ask an agent to read it. The browser and MCP tools share the saved document through the MCP worker.

### Run locally

For a fresh checkout, install dependencies and build the SDK packages from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build-package
```

Start the MCP app in one terminal:

```bash
pnpm --filter mcp-app dev
```

Start the examples app in another terminal:

```bash
pnpm --filter examples.tldraw.com dev
```

Open <http://localhost:5420/boards>, create a named board, and wait for **Saved**. Connect your MCP client to <http://127.0.0.1:8787/mcp> and ask:

> Find my saved board named "Weekly planning" with search_boards, then use read_board to summarize it.

Reconnect an existing MCP client after updating the server so it discovers the new tools. `search_boards` searches names and IDs, and `read_board` returns saved records and extracted text. To edit an existing rectangle, text shape or note, call `read_board` to find its exact `shapeId` and current `revision`, then call `set_board_shape_text` with `boardId`, `shapeId`, `expectedRevision` and `text`. This updates the saved document even when no browser tab or MCP widget is open. The operation replaces rich text with plain text. If a stale revision is rejected, read the board again before trying another edit. If the board is open in the browser, reload it to see the new text; unsaved browser edits cannot be silently merged. For paginated reads, pass the returned `nextOffset` and `revision` so a change between requests is detected.

The `/boards` page can import `.tldr` files and its own downloaded `.tldraw-board.json` copies. Each import creates a new board. Existing canvases in `/basic/full` and the MCP widget are separate documents; import or copy their contents into a named board when you want these tools to read them. Widget `exec` calls continue to operate on the widget's canvas.

### LAN and Tailscale access

Set `NAMED_BOARD_ALLOWED_ORIGINS` in `apps/mcp-app/.dev.vars` to the browser addresses you use. Replace these example addresses with your own:

```dotenv
NAMED_BOARD_ALLOWED_ORIGINS="http://192.168.1.50:5420,http://100.101.102.103:5420,https://board-host.example-tailnet.ts.net"
```

Each entry is an exact origin: scheme, hostname or IP, and port when it is not the default. Use literal URLs in this setting; dotenv variable interpolation such as `${BOARD_HOST}` is not supported by the examples server. Omit paths, query strings, trailing slashes, and wildcards. Use the browser-facing web port, normally `5420`. List the server addresses you open in a browser; connecting devices do not each need an entry. `localhost`, `127.0.0.1`, and `[::1]` remain available without this setting.

The examples Vite server reads the same setting to allow the corresponding hostnames. For the default local worker, `.dev.vars` takes precedence; when it is absent, `.env` and `.env.local` are merged, with `.env.local` taking precedence. Keep your existing environment file and other settings. Vite uses only the origin list for server configuration and does not expose the worker's token to the browser bundle.

Restart both the examples server and MCP worker after changing this setting. The web server must also listen on an address reachable from your LAN or tailnet; `pnpm --filter examples.tldraw.com dev` uses Vite's `--host` option. An existing service that already serves `/boards` over your network can keep its current listening address. Browser board requests are proxied to the MCP worker at `127.0.0.1:8787` on the same server.

Board creation uses tldraw's ID generator and works on HTTP network origins where the browser does not expose `crypto.randomUUID()`.

### Authentication

If you already set `MCP_AUTH_TOKEN`, the same bearer token protects the named-board API. The browser prompts for it and keeps it only in memory for the open page. Keep the token configured in your MCP client as well. With no token configured, the worker does not require one. The deployment has one shared board catalog and does not add per-user accounts.

### Storage and editing limits

The agent reads the last successfully saved document. Wait for **Saved** before asking it to inspect your latest changes. `search_boards` and `read_board` inspect named boards; `set_board_shape_text` also updates existing geo, text and note shape labels. These tools do not create or move shapes, take screenshots, or perform OCR. Embedded media remains in the saved document, but its bytes are omitted from tool results. External asset URLs are not fetched by the tools.

Each save request is limited to 10 MiB, including embedded image and video data. Two open tabs do not merge concurrent edits: an older tab's save is rejected when another tab has saved a newer revision. Use **Download unsaved copy** to preserve your draft before choosing **Reload saved version**.

In local Wrangler development, the board data lives in `apps/mcp-app/.wrangler/state`, or the directory selected with `--persist-to`. Keep the worker's name, working directory, and persistence path stable when updating. To back up the database, stop the worker and copy its entire persistence directory. **Download copy** provides a portable backup of an individual board.

### Update through Git

Update the branch your deployment tracks from the repository root:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
```

Restart the existing web and MCP processes. For user services named `tldraw-web.service` and `tldraw-mcp.service`:

```bash
systemctl --user restart tldraw-mcp.service tldraw-web.service
```

If you have source edits from an earlier manual installation, review `git status` and `git diff` and preserve those edits before switching branches or pulling. Reconcile overlapping changes with the tracked implementation. Keep your local environment file and Wrangler persistence directory; source updates do not require resetting the board database.

## Developing

### Prerequisites

The widget build depends on generated files (`editor-api.json`, `method-map.json`) that are extracted from the editor's TypeScript declarations. Before you can develop or build the mcp-app, you need to build the core packages first:

```bash
# from the repo root
pnpm build
```

This produces the `.tsbuild/` output that `pnpm extract-api` reads from. The `build` and `dev` scripts run `extract-api` automatically, so you don't need to call it separately.

### Package scripts

Run all commands from `apps/mcp-app`.

| Command           | What it does                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm build`      | Build the widget HTML                                                                                           |
| `pnpm dev`        | Build widget + start local Cloudflare worker (HTTP MCP on `localhost:8787`)                                     |
| `pnpm dev:tunnel` | Build widget + start a stable named Cloudflare tunnel + local worker with `WORKER_ORIGIN` set to the tunnel URL |
| `pnpm run deploy` | Build widget + deploy the Cloudflare worker to production                                                       |

`pnpm dev:tunnel` requires the `cloudflared` CLI to be installed on your machine and a one-time `cloudflared tunnel login`. It serves a stable per-user hostname (`<user>-mcp-app-dev.tldraw.xyz`) via a named tunnel, so the URL you register in hosted MCP clients stays the same across runs instead of changing every time. The user slug defaults to `whoami`; override it (or the zone/port) with `MCP_TUNNEL_USER`, `MCP_TUNNEL_ZONE`, and `PORT`. The zone must be a Cloudflare-hosted zone (`tldraw.xyz` is; `tldraw.dev`/`tldraw.com` are on Vercel and won't work).

The worker defaults to production-safe behavior in `wrangler.toml`, including setting `MCP_IS_DEV="false"`. Local HTTP dev scripts override that with `MCP_IS_DEV=true` so local Claude/ChatGPT connectors suppress `ui.domain` while production deployments keep it enabled.

### Cursor setup

Add these two servers in `~/.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"tldraw": {
			"transport": "http",
			"url": "https://tldraw-mcp-app.tldraw.workers.dev/mcp"
		},
		"tldraw-local": {
			"command": "npx",
			"args": ["-y", "mcp-remote", "http://127.0.0.1:8787/mcp"]
		}
	}
}
```

### Claude Desktop local setup

For local Claude Desktop development, use `claude_desktop_config.json` with the local HTTP server:

```json
{
	"mcpServers": {
		"tldraw-local": {
			"command": "npx",
			"args": ["-y", "mcp-remote", "http://127.0.0.1:8787/mcp"]
		}
	}
}
```

### Claude Desktop remote setup

If you'd like to try the remote MCP server in Claude Desktop, use the in-app connector flow rather than adding the production URL to `claude_desktop_config.json`.

1. Open Claude Desktop
2. In the sidebar, go to **Customize**
3. Open **Connectors**
4. Click the button to add a connector, then choose **Add custom connector**
5. Give it a name such as `tldraw`
6. Paste `https://tldraw-mcp-app.tldraw.workers.dev/mcp` as the server URL

The **Add custom connector** option is not available on the free plan, so you may need Max or another paid plan.

If you need Notion access in Claude Desktop, use the Notion MCP connector for that separately.

### ChatGPT local dev

ChatGPT requires an HTTPS origin, so you need a Cloudflare tunnel. You must be an admin of your OpenAI org/workspace to do local dev.

First-time setup (once per machine):

1. Run `cloudflared tunnel login` and choose the `tldraw.xyz` zone

Then, each session:

1. Run `pnpm dev:tunnel` in `apps/mcp-app`
2. It serves your stable hostname, e.g. `https://<user>-mcp-app-dev.tldraw.xyz` (the first run also creates the named tunnel and its DNS route)
3. In ChatGPT web (not the desktop app), go to **Apps** and add your app using that URL
4. You can then test in both ChatGPT web and the desktop or mobile apps

Because the hostname is stable per user, you only add the app in ChatGPT once — subsequent `pnpm dev:tunnel` runs reuse the same URL.

`dev:tunnel` automatically wires `WORKER_ORIGIN` to the stable tunnel URL and sets `MCP_IS_DEV=true` for the local worker.

### Iteration loop

1. Make code changes in `apps/mcp-app`
2. Run the relevant script (`dev` or `dev:tunnel`)
3. Disconnect and reconnect the MCP server in your client (or reload the page/app)
4. When making widget changes, make sure to rebuild, either by running `pnpm build` or rerunning any of the dev scripts.

Reconnecting the server after changes is the most reliable way to pick up new code, especially when the widget HTML changes.

## Session storage lifecycle

Each MCP session is a `TldrawMCP` Durable Object. It keeps up to `MAX_CHECKPOINTS` (50) canvas snapshots and destroys itself after `IDLE_TTL_MS` (7 days) without a checkpoint save — a schedule armed in `init()` and re-armed on every check.

## Contact

Find us on Twitter/X at [@tldraw](https://twitter.com/tldraw).

## Community

Have questions, comments or feedback? [Join our discord](https://discord.tldraw.com/?utm_source=github&utm_medium=readme&utm_campaign=sociallink). For the latest news and release notes, visit [tldraw.dev](https://tldraw.dev).
