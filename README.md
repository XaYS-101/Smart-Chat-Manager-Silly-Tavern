[English](README.md) | [Русский](README_ru.md)

---

# Smart Chat Manager

A SillyTavern extension that brings real chat-management ergonomics to a frontend that has, frankly, never had any. It auto-titles your chats, lets you tag them, ships a prompt library and a multi-profile API manager, and overhauls the chats panel with search, sort, and inline badges.

---

## Features

### 1. Auto-naming chats.
- After a configurable threshold (default: 6 messages) and only once per chat, asks the LLM for a title that includes `{{char}}`.
- Optional confirmation modal lets you accept or decline the suggestion.
- Suggested title is sanitised and applied via ST's official `renameChat()`.

### 2. Tagging system
- **Manual:** add / remove tags from the extension settings panel for the current chat.
- **Auto-Tag button:** asks the LLM for 3-5 short comma-separated keyword tags.
- Tags live in extension, keyed by chat file name. The chat `.jsonl` files are never modified.

### 3. Past Chats UI overhaul
Injected into the existing Manage Chat Files popup:
- 🔎 Tag-search bar (multi-term, AND logic).
- 🔃 Sort dropdown: Last Message Date / Date Created / Alphabetical.
- 🏷️ Coloured tag badges under each chat name.

### 4. Prompt Library (system-prompt manager)
- Two built-in prompts ship by default: **Default Naming** and **Default Tagging**.
- Each saved prompt has a type (naming / tagging) so it only appears in the matching dropdown.
- Edit / create / delete prompts in the modal editor.
- Built-in prompts cannot be deleted, but **can be reset** to the shipped defaults at any time.
- Placeholders supported in the system prompt: `{{char}}`, `{{user}}`. The chat **transcript** is sent automatically as the user message.

### 5. Multi-profile API manager + rotation
- Save an unlimited number of OpenAI-compatible API profiles. Each has a name, URL, key, and model.
- Pick the active profile from a dropdown, or enable Rotate to cycle through them round-robin on every call (great for spreading naming/tagging traffic across keys, or for resilience if one profile is rate-limited).
- Two request shapes:
  - **Chat Completion** — sends the standard messages array with `{role:"system"}` + `{role:"user"}.
  - **Text Completion** — concatenated single prompt for legacy `/completions` endpoints.
- Existing single-config installs are auto-migrated to a profile on first load.

### 6. Localization (EN / RU)
- Full English and Russian dictionaries.
- Toggle in the settings panel; updates the UI live without reload.
- Toasts and the rename modal are also translated.

---

## Installation

In SillyTavern → **Extensions → Install extension**, paste the repo URL.

## Error handling

- LLM failures (network, HTTP error, malformed response) are caught and surfaced as a Toastr error containing the underlying message.
- The extension marks each chat as "naming attempted" after a try, success or fail, so it won't badger you on every subsequent message. Use **Suggest a Name Now** to retry manually.
- Tag persistence uses ST's debounced settings saver — your tags survive reload, character switch, and chat rename.

---

## License

MIT.
