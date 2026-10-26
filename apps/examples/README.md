# Examples

Development environment and examples for the tldraw SDK. A live version of the examples is found here: [examples.tldraw.com](https://examples.tldraw.com)

If you're interested in contributing a new example, please see our [example writing guide](./writing-examples.md) for detailed guidelines on creating effective examples.

## Named boards for MCP

The local `/boards` page lets you create named documents, draw in the browser, and later ask an MCP agent to read a saved board by name. Run the examples app together with `apps/mcp-app`; see the [named-board setup](../mcp-app/README.md#named-browser-boards) for commands, authentication, storage, and updates through Git.

Open <http://localhost:5420/boards>, create or import a board, and wait for **Saved**. The MCP server exposes `search_boards` and `read_board` for these documents, including when the browser tab is closed. Existing basic-example and MCP-widget canvases can be copied or imported into a named board.

For LAN or Tailscale access, configure `NAMED_BOARD_ALLOWED_ORIGINS` in `apps/mcp-app/.dev.vars` with the exact web origins you use. The examples server derives its allowed hostnames from this same setting. Restart both servers after changing it; see [LAN and Tailscale access](../mcp-app/README.md#lan-and-tailscale-access) for examples and environment-file precedence.

## Distributions

You can find tldraw on npm [here](https://www.npmjs.com/package/@tldraw/tldraw?activeTab=versions).

## Contribution

Found a bug? Please [submit an issue](https://github.com/tldraw/tldraw/issues/new).

## License

This project is provided under the MIT license found [here](https://github.com/tldraw/tldraw/blob/main/apps/examples/LICENSE.md).

## Trademarks

Copyright (c) 2024-present tldraw Inc. The tldraw name and logo are trademarks of tldraw. Please see our [trademark guidelines](https://github.com/tldraw/tldraw/blob/main/TRADEMARKS.md) for info on acceptable usage.

## Contact

Find us on Twitter/X at [@tldraw](https://twitter.com/tldraw).

## Community

Have questions, comments or feedback? [Join our discord](https://discord.tldraw.com/?utm_source=github&utm_medium=readme&utm_campaign=sociallink). For the latest news and release notes, visit [tldraw.dev](https://tldraw.dev).
