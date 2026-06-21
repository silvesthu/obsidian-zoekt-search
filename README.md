# Obsidian Zoekt Search

Prompt-style vault search for Obsidian backed by a local Zoekt HTTP API.

## Requirements

- Obsidian desktop.
- A local Zoekt webserver listening at `http://127.0.0.1:6070/api/search`.
- A Zoekt repository/index for the vault. By default, the plugin uses the vault folder name lowercased.

## Settings

- **Search endpoint:** raw Zoekt API endpoint.
- **Zoekt repo:** Zoekt repository/index name. Leave blank to use the vault folder name lowercased.
- **Log level:** `Basic` logs startup and errors only; `Verbose` logs search, UI, and selection diagnostics.
- **Maximum matches:** maximum match rows to request and display.
- **Context lines:** surrounding lines returned for each match.
- **Regex:** pass the query through as a raw Zoekt/RE2 expression.
- **Literal spaces:** treat spaces as part of one literal phrase; disable to search words as AND terms.

## Attribution

The modal UI structure and styling are based on [Obsidian Omnisearch](https://github.com/scambier/obsidian-omnisearch).

## License

GPL-3.0-only. See [LICENSE](LICENSE).
