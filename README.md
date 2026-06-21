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
- **Regex:** default regex state for newly opened search windows.
- **Literal spaces:** treat spaces as part of one literal phrase; disable to search words as AND terms.

## Commands

- **Search Text:** searches file contents.
- **Search File:** searches vault-relative filenames with Zoekt `file:` atoms. Typing `file:foo` is also accepted; the `file:` prefix is stripped before building the filename query.

In either search window, the **Toggle Regex in search window** command toggles Regex for that window only. Assign a hotkey to that command in Obsidian's hotkey settings. The current Regex state and configured hotkey are shown at the right of the search box.

## Attribution

The modal UI structure and styling are based on [Obsidian Omnisearch](https://github.com/scambier/obsidian-omnisearch).

## License

GPL-3.0-only. See [LICENSE](LICENSE).

Omnisearch distributes the GPL version 3 license text and does not state "or later".
`GPL-3.0-only` is the SPDX expression for GPLv3 with no later-version grant.
