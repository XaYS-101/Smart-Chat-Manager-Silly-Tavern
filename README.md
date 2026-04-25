[English](README.md) | [Русский](README_ru.md)

---

# Smart Chat Manager

A SillyTavern extension that brings actual chat-management tools to a frontend that's never really had them. Auto-titles your chats, tags them, helps you organize them into folders (in one character), and overhauls the past-chats panel with tag-based-search, bulk operations, and inline badges. Also ships with a prompt library and multi-profile API manager.

**Important:** Your chats are intended to be safe and won't be corrupred no matter what since every data that this extension makes (except renaming) would not touch your original chat and after deleting everything will return. (But still make backup)

**Note:** This extension is actively developed and not perfect. Bugs can and will happen. If something breaks, check the browser console for errors and report issues with details. I will try to see what I can do about it.

---

## Features

### 1. Auto-naming chats
Your chats get titles automatically after a configurable threshold (default: 6 messages). The LLM suggests a name that includes `{{char}}`, and you can accept or decline it via an optional confirmation modal. You can change what will be in name later if you want.

### 2. Tagging system
Tag your chats manually from the settings panel, or hit the **Auto-Tag** button and let the LLM suggest 3-5 keyword tags. Tags live in the extension settings (keyed by chat filename), so your original `.jsonl` files stay untouched.

### 3. Folder system
Organize your chats into folders that show up as collapsible groups in the past-chats list:
- **Nested folders:** Create subfolders inside folders. Go as deep as you want.
- **Per-row move button:** Click the folder icon on any chat to move it somewhere else.
- **Bulk move:** Select multiple chats and move them all at once.
- **Branch prompt:** When you create a branch, you'll get prompted to organize it. Options include moving it to the parent's folder, any ancestor folder, creating a new subfolder, or picking a different folder entirely.
- **Subfolder creation:** Each folder header has a folder-plus icon. Click it to create a subfolder right there.

### 4. Past Chats UI overhaul
The extension injects new controls into ST's existing "Manage Chat Files" popup:
- **Tag-search bar** — Type tag keywords (multi-term, AND logic) to filter chats.
- **Colored tag badges** — Show up under each chat name.
- **Folder groups** — Collapsible sections with expand/collapse toggles.
- **Bulk selection mode** — Hit "Select" to toggle checkboxes on all chats, then use "Move selected (N)" to bulk-move them.
- **New folder button** — Create top-level folders on the fly.

### 5. Prompt Library
Manage your system prompts for renaming or tagging in one place:
- Two built-in prompts ship by default: **Default Naming** and **Default Tagging**.
- Each prompt has a type (naming or tagging) so it only shows up in the right dropdown.
- Edit, create, or delete prompts in the modal editor.
- Built-in prompts can't be deleted, but you can reset them to defaults anytime.
- Supports placeholders: `{{char}}`, `{{user}}`. The chat transcript gets sent automatically as the user message.

### 6. Multi-profile API manager
Save as many OpenAI-compatible API profiles as you want or use your current connection profile. Each one has a name, URL, key, and model:
- Pick the active profile from a dropdown, or enable **Rotate** to cycle through them round-robin on every call.
- Two request formats:
  - **Chat Completion** — Standard messages array with `{role:"system"}` + `{role:"user"}`.
  - **Text Completion** — Single concatenated prompt for legacy `/completions` endpoints.
- If you're upgrading from a single-config setup, it'll auto-migrate to a profile on first load.

### 7. Localization (EN / RU)
Full English and Russian translations. Toggle the language in settings and the UI updates live without reloading. Toasts and modals are translated too.

### 8. Mobile-responsive
The folder UI works on phones. Tap targets are at least 32px for easy interaction, and toolbar buttons wrap properly on narrow screens.

---

## Installation

In SillyTavern, go to **Extensions → Install extension** and paste the repo URL.

## Known limitations & quirks

- **LLM failures** (network issues, HTTP errors, malformed responses) get caught and shown as Toastr errors with the underlying message. The extension marks each chat as "naming attempted" after one try (success or fail), so it won't keep nagging you. Use **Suggest a Name Now** to retry manually.
- **Tag and folder data** lives in ST's extension settings. It survives reloads, character switches, and chat renames, but if you manually edit or delete your settings file, you'll lose it.
- **Branch prompts** fire once per branch. If you cancel the prompt, it'll ask again next time you open that branch. If you pick "Leave outside any folder," it won't ask again.
- **Nested folder depth** is unlimited, but the UI gets cramped on mobile after 3-4 levels. Use sparingly if you're on a phone.

---

## License

MIT.
