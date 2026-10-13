# Sheaf Privacy Policy

_Last updated: 2026-10-12_

Sheaf is a browser extension that organizes your tabs. It has no server of its own: the developer
collects nothing, runs no analytics, and receives no data from the extension. This policy describes
what the extension handles on your device and what it sends to the AI providers **you** configure.

## What the extension reads

- **Tab metadata** for the windows you organize: tab titles, URLs, tab group names and colors, and
  pinned/active/audible state. Sheaf never reads page content: it has no content scripts and no
  `scripting` permission.
- **Nothing else.** It does not read cookies, browsing history, bookmarks, downloads, or form data.

## What leaves your device

Data is sent only to the AI provider endpoints you configure in Settings (an organizer model, an
optional embedding model for search by meaning, and an optional decision model for auto-filing).
Nothing is sent until you configure a provider. Each request goes only to that exact origin, and
redirects are refused.

What a request can contain:

- **Sanitized tab titles.** Control and bidirectional characters are stripped, URLs inside titles
  are reduced to a label, and anything that looks like a token, UUID, email address, or long number
  is replaced with a placeholder.
- **The site**, depending on the detail level you choose under **Settings → Privacy**: the
  registrable domain (e.g. `example.com`), the hostname, or the hostname plus the path, with
  identifiers redacted. Query strings, fragments, and credentials in URLs are never sent.
- **Existing group names**, with identifiers redacted (can be turned off).
- **Your search text**, when search by meaning is on, with identifiers redacted.
- **Temporary keys** (`t1`, `g1`, …) instead of browser tab and group IDs.

Localhost, private-network, and local-file tabs are included by default with the same sanitizing
(local files send only the title and a local-file label, never the path); each can be turned off,
and allow and deny lists limit which domains are eligible. You can open the exact request before it
is sent.

The provider handles that data under its own privacy policy. Pick a provider whose terms you accept,
or run a model locally.

## What is stored on your device

| Where | What | How long |
|---|---|---|
| `chrome.storage.session` | API keys and custom headers (by default), the undo point, the auto-filing log with tab titles | Until the browser closes |
| `chrome.storage.local` | Settings, saved workspaces (tab titles and URLs), history counts, usage counts (requests, tokens, cost), up to 100 diagnostic events (counts and timings, no titles or URLs) | Until you delete them or uninstall |
| `chrome.storage.local`, opt-in | An API key, if you turn on **Remember key after the browser closes**. It is stored as plain text, so only use it on a device you trust | Until you turn it off or uninstall |
| IndexedDB | The search-by-meaning index: sanitized tab documents and their embedding vectors | Until you clear the index or uninstall |

Sheaf does not use `chrome.storage.sync`, so nothing is synced to your Google account.

## Permissions

- `tabs`, `tabGroups`: read and arrange your tabs and groups.
- `storage`, `unlimitedStorage`: the local storage above. Unlimited storage keeps the browser from
  evicting the search index.
- `alarms`, `notifications`, `contextMenus`: background indexing, auto-filing notices with Undo, and
  the right-click menu entries.
- `favicon`: shows site icons in the extension's own pages, served by the browser from its local
  cache. Icons are never sent anywhere.
- **Optional host permissions** (`https://*/*` and localhost): your provider could be on any HTTPS
  origin, and the browser only grants hosts the manifest lists. Nothing is requested at install;
  when you save a provider, the extension asks for that one host.

A provider origin can be a public host, a private-network host over HTTPS (for example a model on
your LAN), or localhost over HTTP. You choose it, and requests go nowhere else.

## Your choices

- Turn off any provider, auto-filing, or search by meaning in Settings.
- Clear the search index, diagnostics, history, and saved workspaces from Settings.
- Uninstalling the extension removes everything it stored.

## Changes and contact

Changes to this policy are published in the repository at
<https://github.com/ItsBreadTime/Sheaf>. Questions go to the repository's issue tracker.
