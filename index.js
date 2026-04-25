/*
 * Smart Chat Manager
 * --------------------------------------------------------------
 *  - Auto-generates chat titles via the active ST API or a
 *    user-supplied OpenAI-compatible endpoint.
 *  - Tags chats (manual or LLM-suggested) and stores them inside
 *    extension_settings, keyed by chat file name; the original
 *    .jsonl chat files stay untouched.
 *  - Overhauls the "Past Chats" panel with a tag search box, a
 *    sort dropdown and inline tag badges.
 *  - Manages a library of saved system prompts used for naming
 *    and tagging. Placeholders {{char}} and {{user}} are
 *    substituted at request time. The chat transcript is sent
 *    as the user message.
 *  - Manages multiple OpenAI-compatible API profiles with
 *    optional round-robin rotation, and supports both Chat
 *    Completion and Text Completion request shapes.
 *  - Even when using ST Default, the connection profile's
 *    system prompt is replaced with the selected prompt from
 *    the Prompt Library (via generateRaw + instructOverride).
 *  - Russian / English UI toggle.
 */

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    renameChat,
    getCurrentChatId,
    chat as currentChat,
    chat_metadata,
    characters,
    this_chid,
    name1,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

import {
    callGenericPopup,
    POPUP_TYPE,
    POPUP_RESULT,
} from '../../../popup.js';

import { selected_group } from '../../../group-chats.js';

/* ------------------------------------------------------------------
 *  Constants
 * ------------------------------------------------------------------ */

const MODULE_NAME = 'SmartChatManager';

/* ------------------------------------------------------------------
 *  Settings panel HTML
 *
 *  Inlined so the extension works as long as index.js itself is
 *  loaded, regardless of how the user copied or cloned the rest of
 *  the package. The `settings.html` file in this package is kept as
 *  documentation; it is no longer fetched at runtime.
 * ------------------------------------------------------------------ */

const SETTINGS_HTML = `
<div id="scm_settings" class="scm-extension">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b data-scm-i18n="ext_title">Smart Chat Manager</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <div class="scm-section">
                <label for="scm_language" data-scm-i18n="language">Language</label>
                <select id="scm_language" class="text_pole">
                    <option value="en">English</option>
                    <option value="ru">Русский</option>
                </select>
            </div>

            <hr class="sysHR" />

            <div class="scm-section">
                <h4 data-scm-i18n="auto_name_header">Automatic Chat Naming</h4>
                <label class="checkbox_label" for="scm_auto_name_enabled">
                    <input id="scm_auto_name_enabled" type="checkbox" />
                    <span data-scm-i18n="auto_name_enabled">Enable auto-naming</span>
                </label>
                <label for="scm_auto_name_threshold" data-scm-i18n="auto_name_threshold">Generate after N messages</label>
                <input id="scm_auto_name_threshold" type="number" class="text_pole" min="2" max="100" step="1" value="6" />
                <label class="checkbox_label" for="scm_auto_name_confirm">
                    <input id="scm_auto_name_confirm" type="checkbox" />
                    <span data-scm-i18n="auto_name_confirm">Ask for confirmation before renaming</span>
                </label>
                <label for="scm_naming_prompt" data-scm-i18n="naming_prompt">Naming system prompt</label>
                <select id="scm_naming_prompt" class="text_pole"></select>
                <div class="flex-container">
                    <input id="scm_manual_rename" class="menu_button menu_button_icon" type="button"
                           value="Suggest a Name Now" data-scm-i18n="[value]manual_rename" />
                </div>
            </div>

            <hr class="sysHR" />

            <div class="scm-section">
                <h4 data-scm-i18n="tag_header">Tags for Current Chat</h4>
                <div class="scm-current-tags-row">
                    <div id="scm_current_tags" class="scm-tag-list"></div>
                </div>
                <div class="flex-container">
                    <input id="scm_new_tag" class="text_pole flex1" type="text"
                           placeholder="new tag…" data-scm-i18n="[placeholder]tag_placeholder" />
                    <input id="scm_add_tag" class="menu_button" type="button"
                           value="Add" data-scm-i18n="[value]tag_add" />
                    <input id="scm_auto_tag" class="menu_button" type="button"
                           value="Auto-Tag" data-scm-i18n="[value]tag_auto" />
                </div>
                <label for="scm_tagging_prompt" data-scm-i18n="tagging_prompt">Tagging system prompt</label>
                <select id="scm_tagging_prompt" class="text_pole"></select>
                <small class="scm-hint" data-scm-i18n="tag_hint">
                    Tags are stored inside the extension's settings, not inside the chat file.
                </small>
            </div>

            <hr class="sysHR" />

            <div class="scm-section">
                <h4 data-scm-i18n="pm_header">Prompt Library</h4>
                <small class="scm-hint" data-scm-i18n="pm_hint">
                    System prompts used for naming and tagging. Placeholders:
                    <code>{{char}}</code>, <code>{{user}}</code>. The chat transcript is sent
                    automatically as the user message.
                </small>
                <div class="flex-container">
                    <input id="scm_open_prompt_manager" class="menu_button menu_button_icon" type="button"
                           value="Manage Prompts…" data-scm-i18n="[value]pm_open" />
                </div>
            </div>

            <hr class="sysHR" />

            <div class="scm-section">
                <h4 data-scm-i18n="api_header">LLM Source for Naming &amp; Tagging</h4>
                <label for="scm_api_source" data-scm-i18n="api_source">API Source</label>
                <select id="scm_api_source" class="text_pole">
                    <option value="st" data-scm-i18n="api_source_st">ST Default (active connection)</option>
                    <option value="custom" data-scm-i18n="api_source_custom">Custom API (OpenAI-compatible)</option>
                </select>
                <small class="scm-hint" data-scm-i18n="api_st_hint">
                    Even when using ST Default, the connection profile's system prompt is
                    overridden with the prompts from the Prompt Library above.
                </small>

                <div id="scm_custom_api_block" class="scm-subsection">
                    <label for="scm_completion_mode" data-scm-i18n="completion_mode">Completion mode</label>
                    <select id="scm_completion_mode" class="text_pole">
                        <option value="chat" data-scm-i18n="completion_mode_chat">Chat Completion (system + user)</option>
                        <option value="text" data-scm-i18n="completion_mode_text">Text Completion (single prompt)</option>
                    </select>

                    <label class="checkbox_label" for="scm_api_rotate">
                        <input id="scm_api_rotate" type="checkbox" />
                        <span data-scm-i18n="api_rotate">Rotate through saved profiles (round-robin)</span>
                    </label>

                    <hr class="sysHR" />

                    <label for="scm_profile_select" data-scm-i18n="api_active_profile">Active Profile</label>
                    <div class="flex-container">
                        <select id="scm_profile_select" class="text_pole flex1"></select>
                        <input id="scm_profile_new" class="menu_button" type="button"
                               value="New" data-scm-i18n="[value]api_new" />
                        <input id="scm_profile_delete" class="menu_button" type="button"
                               value="Delete" data-scm-i18n="[value]api_delete" />
                    </div>

                    <label for="scm_profile_name" data-scm-i18n="api_profile_name">Profile name</label>
                    <input id="scm_profile_name" type="text" class="text_pole" placeholder="My profile" autocomplete="off" />

                    <label for="scm_custom_url" data-scm-i18n="api_url">API URL</label>
                    <input id="scm_custom_url" type="text" class="text_pole" placeholder="https://api.openai.com/v1" autocomplete="off" />

                    <label for="scm_custom_key" data-scm-i18n="api_key">API Key</label>
                    <input id="scm_custom_key" type="password" class="text_pole" placeholder="sk-…" autocomplete="off" />

                    <label for="scm_custom_model" data-scm-i18n="api_model">Model Name</label>
                    <input id="scm_custom_model" type="text" class="text_pole" placeholder="gpt-4o-mini" autocomplete="off" />

                    <div class="flex-container">
                        <input id="scm_profile_save" class="menu_button" type="button"
                               value="Save Profile" data-scm-i18n="[value]api_save" />
                    </div>

                    <small class="scm-hint" data-scm-i18n="api_hint">
                        Keys are stored inside the extension's settings on this device only.
                        Never share or commit your settings file.
                    </small>
                </div>
            </div>

            <hr class="sysHR" />

            <!-- ====================== Reset ====================== -->
            <div class="scm-section">
                <h4 data-scm-i18n="reset_header">Reset Extension</h4>
                <small class="scm-hint" data-scm-i18n="reset_hint">
                    Erases every Smart Chat Manager setting on this device:
                    folders, tags, auto-naming history, custom prompts and API
                    profiles. Your actual chat files are not affected.
                </small>
                <div class="flex-container">
                    <input id="scm_reset_all" class="menu_button redWarningBG" type="button"
                           value="Delete All Extension Data" data-scm-i18n="[value]reset_button" />
                </div>
            </div>

        </div>
    </div>
</div>
`;

const DEFAULT_PROMPTS = Object.freeze({
    default_naming: {
        id: 'default_naming',
        name: 'Default Naming',
        type: 'naming',
        builtIn: true,
        systemPrompt:
`You are a roleplay chat title generator. The chat is between {{user}} and {{char}}.
You will receive the recent transcript as the user message.

Reply with ONE short title that captures the current context.

Strict rules:
- 5 to 10 words.
- The title MUST include the character name "{{char}}".
- No quotes, emojis, or punctuation other than spaces and dashes.
- Reply with ONLY the title text on a single line. No preamble, no explanation, no labels.`,
    },
    default_tagging: {
        id: 'default_tagging',
        name: 'Default Tagging',
        type: 'tagging',
        builtIn: true,
        systemPrompt:
`You are a roleplay chat tagger. The chat is between {{user}} and {{char}}.
You will receive the transcript as the user message.

Reply with 3 to 5 short, lowercase keyword tags that describe its themes, mood or genre.

Examples of valid tags: nsfw, tavern, angst, sci-fi, comedy, romance, hurt-comfort.

Reply with ONLY a single line of comma-separated tags. No prose, no headers, no numbering.`,
    },
});

const DEFAULT_SETTINGS = {
    language: 'en',

    autoName: {
        enabled: true,
        threshold: 6,
        confirm: true,
        promptId: 'default_naming',
    },
    autoTag: {
        promptId: 'default_tagging',
    },

    tags: {},                        // { [chatKey]: string[] }
    autoNamed: {},                   // { [chatKey]: true }

    folders: {},                     // { [folderId]: { id, name, chats: chatKey[], collapsed: bool } }
    chatFolder: {},                  // { [chatKey]: folderId }
    branchPromptedFor: [],           // chatKeys we've already shown the branch prompt for

    prompts: {                       // populated from DEFAULT_PROMPTS on first run
        default_naming: { ...DEFAULT_PROMPTS.default_naming },
        default_tagging: { ...DEFAULT_PROMPTS.default_tagging },
    },

    api: {
        source: 'st',                // 'st' | 'custom'
        completionMode: 'chat',      // 'chat' | 'text'
        rotate: false,
        rotateIndex: 0,
        profiles: [],                // [{ id, name, url, key, model }]
        activeProfileId: null,
    },

    sort: 'last_mes',                // 'last_mes' | 'created' | 'alpha'
    tagSearch: '',
};

/* ------------------------------------------------------------------
 *  Localization
 * ------------------------------------------------------------------ */

const I18N = {
    en: {
        ext_title: 'Smart Chat Manager',
        language: 'Language',

        auto_name_header: 'Automatic Chat Naming',
        auto_name_enabled: 'Enable auto-naming',
        auto_name_threshold: 'Generate after N messages',
        auto_name_confirm: 'Ask for confirmation before renaming',
        manual_rename: 'Suggest a Name Now',
        naming_prompt: 'Naming system prompt',

        tag_header: 'Tags for Current Chat',
        tag_placeholder: 'new tag…',
        tag_add: 'Add',
        tag_auto: 'Auto-Tag',
        tagging_prompt: 'Tagging system prompt',
        tag_hint: 'Tags are stored inside the extension’s settings, not inside the chat file.',

        pm_header: 'Prompt Library',
        pm_hint: 'System prompts used for naming and tagging. Placeholders: {{char}}, {{user}}. The chat transcript is sent automatically as the user message.',
        pm_open: 'Manage Prompts…',
        pm_modal_title: 'Prompt Library',
        pm_select_prompt: 'Prompt',
        pm_name: 'Name',
        pm_type: 'Type',
        pm_type_naming: 'Naming',
        pm_type_tagging: 'Tagging',
        pm_system_prompt: 'System prompt',
        pm_save: 'Save',
        pm_new: 'New',
        pm_delete: 'Delete',
        pm_reset: 'Reset to default',
        pm_close: 'Close',
        pm_builtin_locked: 'Built-in prompts cannot be deleted, but can be reset.',
        pm_new_name_default: 'New prompt',
        pm_confirm_delete: 'Delete this prompt?',
        pm_in_use: 'This prompt is currently selected. Pick another one first.',

        api_header: 'LLM Source for Naming & Tagging',
        api_source: 'API Source',
        api_source_st: 'ST Default (active connection)',
        api_source_custom: 'Custom API (OpenAI-compatible)',
        api_st_hint: 'Even when using ST Default, the connection profile’s system prompt is overridden with the prompts from the Prompt Library above.',

        completion_mode: 'Completion mode',
        completion_mode_chat: 'Chat Completion (system + user)',
        completion_mode_text: 'Text Completion (single prompt)',

        api_rotate: 'Rotate through saved profiles (round-robin)',
        api_active_profile: 'Active Profile',
        api_profile_name: 'Profile name',
        api_url: 'API URL',
        api_key: 'API Key',
        api_model: 'Model Name',
        api_save: 'Save Profile',
        api_new: 'New',
        api_delete: 'Delete',
        api_hint: 'Keys are stored inside the extension’s settings on this device only. Never share or commit your settings file.',
        api_no_profiles: '(no profiles saved yet)',
        api_profile_default: 'Profile',
        api_confirm_delete: 'Delete this API profile?',

        pc_search_placeholder: 'Filter by tag…',
        pc_sort_label: 'Sort',
        pc_sort_last_mes: 'Last Message Date',
        pc_sort_created: 'Date Created',
        pc_sort_alpha: 'Alphabetical',
        pc_no_tags: 'no tags',

        folder_new: 'New folder…',
        folder_name_prompt: 'Folder name',
        folder_delete_confirm: 'Delete this folder? Chats inside will return to the general list.',
        folder_none: 'no folder',
        folder_move_title: 'Move chat to folder',
        folder_move_select_label: 'Pick a folder:',
        folder_rename: 'Rename',
        folder_delete: 'Delete',
        branch_prompt_title: 'Branch created',
        branch_prompt_body: 'Group the parent chat and its branches in one folder. You can edit the folder name below.',
        branch_default_folder_name: 'Branches: {name}',

        reset_header: 'Reset Extension',
        reset_hint: 'Erases every Smart Chat Manager setting on this device: folders, tags, auto-naming history, custom prompts and API profiles. Your actual chat files are not affected.',
        reset_button: 'Delete All Extension Data',
        reset_confirm_1_title: 'Delete all Smart Chat Manager data?',
        reset_confirm_1_body: 'This will permanently erase all folders, tags, auto-naming history, custom prompts and saved API profiles. Chat files on disk are NOT touched.',
        reset_confirm_2_title: 'Are you absolutely sure?',
        reset_confirm_2_body: 'Last chance. This action cannot be undone.',
        reset_done: 'Smart Chat Manager has been reset.',

        toast_no_chat: 'Open a chat first.',
        toast_naming: 'Generating a chat name…',
        toast_tagging: 'Asking the LLM for tags…',
        toast_done: 'Done.',
        toast_failed: 'Smart Chat Manager request failed: ',
        toast_renamed: 'Chat renamed to: ',
        toast_kept: 'Suggestion declined, name kept.',
        toast_no_profile: 'No custom API profile is configured.',
        toast_saved: 'Saved.',

        modal_title: 'Suggested Chat Title',
        modal_text: 'The LLM proposes the following title for this chat:',
        modal_accept: 'Use this name',
        modal_decline: 'Keep current name',
    },
    ru: {
        ext_title: 'Smart Chat Manager (Умный менеджер чатов)',
        language: 'Язык',

        auto_name_header: 'Автоматическое именование чатов',
        auto_name_enabled: 'Включить авто-именование',
        auto_name_threshold: 'Создавать имя после N сообщений',
        auto_name_confirm: 'Спрашивать подтверждение перед переименованием',
        manual_rename: 'Предложить имя сейчас',
        naming_prompt: 'Системный промпт для именования',

        tag_header: 'Теги текущего чата',
        tag_placeholder: 'новый тег…',
        tag_add: 'Добавить',
        tag_auto: 'Авто-теги',
        tagging_prompt: 'Системный промпт для тегов',
        tag_hint: 'Теги хранятся в настройках расширения и не изменяют файл чата.',

        pm_header: 'Библиотека промптов',
        pm_hint: 'Системные промпты для именования и тегов. Плейсхолдеры: {{char}}, {{user}}. Транскрипт чата автоматически отправляется как сообщение пользователя.',
        pm_open: 'Управление промптами…',
        pm_modal_title: 'Библиотека промптов',
        pm_select_prompt: 'Промпт',
        pm_name: 'Имя',
        pm_type: 'Тип',
        pm_type_naming: 'Именование',
        pm_type_tagging: 'Теги',
        pm_system_prompt: 'Системный промпт',
        pm_save: 'Сохранить',
        pm_new: 'Новый',
        pm_delete: 'Удалить',
        pm_reset: 'Вернуть к стандартному',
        pm_close: 'Закрыть',
        pm_builtin_locked: 'Встроенные промпты нельзя удалить, но можно сбросить.',
        pm_new_name_default: 'Новый промпт',
        pm_confirm_delete: 'Удалить этот промпт?',
        pm_in_use: 'Этот промпт сейчас выбран. Сначала выберите другой.',

        api_header: 'Источник LLM для имён и тегов',
        api_source: 'Источник API',
        api_source_st: 'Стандартный ST (активное подключение)',
        api_source_custom: 'Свой API (совместимый с OpenAI)',
        api_st_hint: 'Даже при использовании стандартного ST, системный промпт из профиля подключения заменяется выбранным промптом из библиотеки выше.',

        completion_mode: 'Режим запроса',
        completion_mode_chat: 'Chat Completion (system + user)',
        completion_mode_text: 'Text Completion (один промпт)',

        api_rotate: 'Циклически перебирать сохранённые профили',
        api_active_profile: 'Активный профиль',
        api_profile_name: 'Имя профиля',
        api_url: 'URL API',
        api_key: 'API ключ',
        api_model: 'Имя модели',
        api_save: 'Сохранить профиль',
        api_new: 'Новый',
        api_delete: 'Удалить',
        api_hint: 'Ключи хранятся только в настройках расширения на этом устройстве. Не делитесь файлом настроек и не коммитьте его.',
        api_no_profiles: '(профили ещё не сохранены)',
        api_profile_default: 'Профиль',
        api_confirm_delete: 'Удалить этот профиль API?',

        pc_search_placeholder: 'Фильтр по тегу…',
        pc_sort_label: 'Сортировка',
        pc_sort_last_mes: 'По дате последнего сообщения',
        pc_sort_created: 'По дате создания',
        pc_sort_alpha: 'По алфавиту',
        pc_no_tags: 'нет тегов',

        folder_new: 'Новая папка…',
        folder_name_prompt: 'Название папки',
        folder_delete_confirm: 'Удалить эту папку? Чаты внутри вернутся в общий список.',
        folder_none: 'без папки',
        folder_move_title: 'Переместить чат в папку',
        folder_move_select_label: 'Выберите папку:',
        folder_rename: 'Переименовать',
        folder_delete: 'Удалить',
        branch_prompt_title: 'Создан бранч',
        branch_prompt_body: 'Сгруппировать родительский чат и его бранчи в одну папку. Имя папки можно изменить ниже.',
        branch_default_folder_name: 'Бранчи: {name}',

        reset_header: 'Сброс расширения',
        reset_hint: 'Стирает все настройки Smart Chat Manager на этом устройстве: папки, теги, историю авто-именования, пользовательские промпты и API-профили. Файлы чатов на диске не затрагиваются.',
        reset_button: 'Удалить все данные расширения',
        reset_confirm_1_title: 'Удалить все данные Smart Chat Manager?',
        reset_confirm_1_body: 'Будут безвозвратно удалены все папки, теги, история авто-именования, пользовательские промпты и сохранённые API-профили. Файлы чатов на диске НЕ затрагиваются.',
        reset_confirm_2_title: 'Вы точно уверены?',
        reset_confirm_2_body: 'Последний шанс. Это действие нельзя отменить.',
        reset_done: 'Smart Chat Manager сброшен.',

        toast_no_chat: 'Сначала откройте чат.',
        toast_naming: 'Генерируем имя чата…',
        toast_tagging: 'Запрашиваем теги у LLM…',
        toast_done: 'Готово.',
        toast_failed: 'Ошибка Smart Chat Manager: ',
        toast_renamed: 'Чат переименован: ',
        toast_kept: 'Предложение отклонено, имя сохранено.',
        toast_no_profile: 'Не настроен ни один профиль API.',
        toast_saved: 'Сохранено.',

        modal_title: 'Предложенное имя чата',
        modal_text: 'LLM предлагает следующее имя:',
        modal_accept: 'Использовать имя',
        modal_decline: 'Оставить как есть',
    },
};

function t(key) {
    const lang = (extension_settings[MODULE_NAME] || {}).language || 'en';
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}

function applyTranslations(root = document) {
    root.querySelectorAll('[data-scm-i18n]').forEach((el) => {
        const raw = el.getAttribute('data-scm-i18n');
        const match = raw.match(/^\[(.+?)\](.+)$/);
        if (match) {
            el.setAttribute(match[1], t(match[2]));
        } else {
            el.textContent = t(raw);
        }
    });
}

/* ------------------------------------------------------------------
 *  Settings bootstrap with forward-compat migration
 * ------------------------------------------------------------------ */

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        return extension_settings[MODULE_NAME];
    }
    const s = extension_settings[MODULE_NAME];

    s.language ??= 'en';
    s.autoName ??= structuredClone(DEFAULT_SETTINGS.autoName);
    s.autoName.promptId ??= 'default_naming';
    s.autoTag ??= structuredClone(DEFAULT_SETTINGS.autoTag);
    s.autoTag.promptId ??= 'default_tagging';
    s.tags ??= {};
    s.autoNamed ??= {};
    s.sort ??= 'last_mes';
    s.tagSearch ??= '';

    s.folders ??= {};
    s.chatFolder ??= {};
    s.branchPromptedFor ??= [];

    // One-time migration: re-key tags / autoNamed entries that were stored
    // with a trailing `.jsonl` (a leftover from when refreshPastChatsBadges
    // looked up keys by the past-chats template's filename attribute).
    let migrated = false;
    for (const k of Object.keys(s.tags)) {
        const norm = chatKey(k);
        if (norm !== k) {
            s.tags[norm] = Array.from(new Set([...(s.tags[norm] || []), ...s.tags[k]]));
            delete s.tags[k];
            migrated = true;
        }
    }
    for (const k of Object.keys(s.autoNamed)) {
        const norm = chatKey(k);
        if (norm !== k) {
            s.autoNamed[norm] = s.autoNamed[norm] || s.autoNamed[k];
            delete s.autoNamed[k];
            migrated = true;
        }
    }
    if (migrated) saveSettingsDebounced();

    // Prompts: ensure built-ins exist; preserve user edits to them.
    s.prompts ??= {};
    for (const id of Object.keys(DEFAULT_PROMPTS)) {
        if (!s.prompts[id]) {
            s.prompts[id] = { ...DEFAULT_PROMPTS[id] };
        } else {
            // Keep stored systemPrompt (user may have edited), but lock metadata.
            s.prompts[id].id = DEFAULT_PROMPTS[id].id;
            s.prompts[id].type = DEFAULT_PROMPTS[id].type;
            s.prompts[id].builtIn = true;
            s.prompts[id].name ??= DEFAULT_PROMPTS[id].name;
        }
    }

    // API: migrate legacy single-config to the new profiles list.
    s.api ??= structuredClone(DEFAULT_SETTINGS.api);
    s.api.source ??= 'st';
    s.api.completionMode ??= 'chat';
    s.api.rotate ??= false;
    s.api.rotateIndex ??= 0;
    s.api.profiles ??= [];
    s.api.activeProfileId ??= null;

    if ((s.api.url || s.api.key || s.api.model) && s.api.profiles.length === 0) {
        const id = uid();
        s.api.profiles.push({
            id,
            name: 'Migrated profile',
            url: s.api.url || '',
            key: s.api.key || '',
            model: s.api.model || '',
        });
        s.api.activeProfileId = id;
        delete s.api.url;
        delete s.api.key;
        delete s.api.model;
        saveSettings();
    }

    return s;
}

function saveSettings() {
    saveSettingsDebounced();
}

function uid() {
    return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ------------------------------------------------------------------
 *  Prompt rendering
 * ------------------------------------------------------------------ */

function getActiveCharacterName() {
    if (selected_group) return 'Group';
    const char = characters?.[this_chid];
    return char?.name || 'Character';
}

function getUserName() {
    return (typeof name1 === 'string' && name1) || 'User';
}

function renderTemplate(template, vars) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (m, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
    });
}

function buildRecentTranscript(maxMessages = 15) {
    if (!Array.isArray(currentChat) || currentChat.length === 0) return '';
    const slice = currentChat.slice(-maxMessages);
    return slice
        .filter(m => m && !m.is_system)
        .map(m => `${m.name || (m.is_user ? 'User' : 'Char')}: ${String(m.mes || '').slice(0, 400)}`)
        .join('\n');
}

/**
 * Resolve the system prompt for a given prompt ID, substituting
 * {{char}} / {{user}} placeholders.
 */
function resolveSystemPrompt(promptId) {
    const s = getSettings();
    const p = s.prompts[promptId] || DEFAULT_PROMPTS[promptId];
    if (!p) throw new Error(`Prompt not found: ${promptId}`);
    return renderTemplate(p.systemPrompt, {
        char: getActiveCharacterName(),
        user: getUserName(),
    });
}

/* ------------------------------------------------------------------
 *  API routing
 *
 *  generate({ promptId, transcript, maxTokens })
 *    - Resolves the system prompt from the Prompt Library.
 *    - Routes to ST default or to one of the saved custom
 *      profiles (with optional round-robin rotation).
 *    - For ST default: passes systemPrompt + instructOverride to
 *      generateRaw, replacing the connection profile's prompts
 *      with our naming/tagging prompt + the transcript.
 *    - For custom: emits either Chat Completion (system + user
 *      messages array) or Text Completion (single concatenated
 *      prompt) depending on completionMode.
 * ------------------------------------------------------------------ */

async function generate({ promptId, transcript, maxTokens = 120 }) {
    const systemPrompt = resolveSystemPrompt(promptId);
    const userMessage = transcript || '(empty transcript)';
    const s = getSettings();

    if (s.api.source === 'custom') {
        const profile = pickCustomProfile();
        if (!profile) throw new Error(t('toast_no_profile'));
        return await generateCustom({
            profile,
            systemPrompt,
            userMessage,
            maxTokens,
            mode: s.api.completionMode,
        });
    }

    return await generateST({ systemPrompt, userMessage, maxTokens });
}

/**
 * Pick a custom profile honoring the rotate flag.
 */
function pickCustomProfile() {
    const s = getSettings();
    const list = s.api.profiles;
    if (!list || list.length === 0) return null;

    if (s.api.rotate && list.length > 1) {
        const idx = ((s.api.rotateIndex | 0) % list.length + list.length) % list.length;
        const profile = list[idx];
        s.api.rotateIndex = (idx + 1) % list.length;
        saveSettings();
        return profile;
    }

    if (s.api.activeProfileId) {
        const found = list.find(p => p.id === s.api.activeProfileId);
        if (found) return found;
    }
    return list[0];
}

/**
 * ST default route — uses generateRaw with our system prompt,
 * overriding whatever the active connection profile would have
 * supplied. instructOverride: true skips instruct templating so
 * Chat Completion connections behave consistently with Text
 * Completion ones.
 */
async function generateST({ systemPrompt, userMessage, maxTokens }) {
    const ctx = getContext();
    const result = await ctx.generateRaw({
        prompt: userMessage,
        systemPrompt,
        instructOverride: true,
        responseLength: maxTokens,
    });
    return String(result || '').trim();
}

/**
 * Custom OpenAI-compatible route. Two request shapes:
 *  - chat: messages array with system + user roles.
 *  - text: legacy /completions style with a single prompt.
 *
 * URL handling: a base URL like "https://api.openai.com/v1" gets
 * the appropriate suffix appended; a fully-qualified endpoint URL
 * is used as-is.
 */
async function generateCustom({ profile, systemPrompt, userMessage, maxTokens, mode }) {
    if (!profile.url || !profile.model) {
        throw new Error('Profile is missing URL or model.');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (profile.key) headers['Authorization'] = `Bearer ${profile.key}`;

    const base = profile.url.replace(/\/+$/, '');
    let url, body;

    if (mode === 'text') {
        url = /\/(completions|chat\/completions)$/.test(base) ? base : `${base}/completions`;
        body = {
            model: profile.model,
            max_tokens: maxTokens,
            temperature: 0.7,
            prompt: `${systemPrompt}\n\n---\n\n${userMessage}\n\n---\n\nResponse:`,
        };
    } else {
        url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
        body = {
            model: profile.model,
            max_tokens: maxTokens,
            temperature: 0.7,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
        };
    }

    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();

    // Accept both chat-completion and text-completion response shapes.
    const content =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.text;
    if (typeof content !== 'string') {
        throw new Error('Unexpected response shape from custom endpoint.');
    }
    return content.trim();
}

/* ------------------------------------------------------------------
 *  Auto-naming
 * ------------------------------------------------------------------ */

function sanitizeFileName(name) {
    return String(name)
        .replace(/^["'`\s]+|["'`\s]+$/g, '')
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

async function suggestChatName() {
    const transcript = buildRecentTranscript(15);
    if (!transcript) return null;

    const s = getSettings();
    const raw = await generate({
        promptId: s.autoName.promptId,
        transcript,
        maxTokens: 40,
    });

    const firstLine = raw.split(/\r?\n/).find(line => line.trim().length > 0) || '';
    const cleaned = sanitizeFileName(firstLine);
    return cleaned || null;
}

async function confirmRename(suggestion) {
    const html = `
        <h3>${escapeHtml(t('modal_title'))}</h3>
        <p>${escapeHtml(t('modal_text'))}</p>
        <p><b>${escapeHtml(suggestion)}</b></p>
    `;
    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: t('modal_accept'),
        cancelButton: t('modal_decline'),
    });
    return result === POPUP_RESULT.AFFIRMATIVE;
}

async function runAutoName({ force = false } = {}) {
    const s = getSettings();
    const oldFile = getCurrentChatId();
    if (!oldFile) {
        toastr.info(t('toast_no_chat'));
        return;
    }
    if (!force && s.autoNamed[oldFile]) return;
    if (!force && !s.autoName.enabled) return;

    toastr.info(t('toast_naming'));
    let suggestion;
    try {
        suggestion = await suggestChatName();
    } catch (err) {
        console.error(`[${MODULE_NAME}] naming failed`, err);
        toastr.error(t('toast_failed') + (err.message || err));
        return;
    }

    if (!suggestion) {
        toastr.warning(t('toast_failed') + 'empty response');
        return;
    }

    const accept = (force || s.autoName.confirm)
        ? await confirmRename(suggestion)
        : true;

    s.autoNamed[oldFile] = true;
    saveSettings();

    if (!accept) {
        toastr.info(t('toast_kept'));
        return;
    }

    try {
        await renameChat(oldFile, suggestion);
        if (s.tags[oldFile]) {
            s.tags[suggestion] = s.tags[oldFile];
            delete s.tags[oldFile];
        }
        s.autoNamed[suggestion] = true;
        delete s.autoNamed[oldFile];
        saveSettings();
        toastr.success(t('toast_renamed') + suggestion);
    } catch (err) {
        console.error(`[${MODULE_NAME}] rename failed`, err);
        toastr.error(t('toast_failed') + (err.message || err));
    }
}

/* ------------------------------------------------------------------
 *  Tagging
 * ------------------------------------------------------------------ */

function chatKey(name) {
    if (!name) return '';
    return String(name).replace(/\.jsonl$/i, '');
}

function getTags(fileName) {
    const s = getSettings();
    const k = chatKey(fileName);
    return Array.isArray(s.tags[k]) ? s.tags[k] : [];
}

function setTags(fileName, tags) {
    const s = getSettings();
    const k = chatKey(fileName);
    if (!k) return;
    const cleaned = Array.from(new Set(
        (tags || [])
            .map(x => String(x).trim().toLowerCase())
            .filter(x => x.length > 0 && x.length <= 32),
    ));
    if (cleaned.length === 0) {
        delete s.tags[k];
    } else {
        s.tags[k] = cleaned;
    }
    saveSettings();
}

function addTag(fileName, tag) {
    setTags(fileName, [...getTags(fileName), tag]);
}

function removeTag(fileName, tag) {
    setTags(fileName, getTags(fileName).filter(x => x !== tag));
}

/* ------------------------------------------------------------------
 *  Folders
 * ------------------------------------------------------------------ */

function uidFolder() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'f_' + crypto.randomUUID();
    }
    return 'f_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function createFolder(name) {
    const s = getSettings();
    const id = uidFolder();
    s.folders[id] = {
        id,
        name: String(name || '').trim() || 'Folder',
        chats: [],
        collapsed: false,
    };
    saveSettings();
    return id;
}

function renameFolder(folderId, name) {
    const s = getSettings();
    if (!s.folders[folderId]) return;
    s.folders[folderId].name = String(name || '').trim() || s.folders[folderId].name;
    saveSettings();
}

function deleteFolder(folderId) {
    const s = getSettings();
    const f = s.folders[folderId];
    if (!f) return;
    for (const k of f.chats) {
        if (s.chatFolder[k] === folderId) delete s.chatFolder[k];
    }
    delete s.folders[folderId];
    saveSettings();
}

function moveChatToFolder(fileName, folderId) {
    const s = getSettings();
    const k = chatKey(fileName);
    if (!k) return;
    const oldId = s.chatFolder[k];
    if (oldId && s.folders[oldId]) {
        s.folders[oldId].chats = s.folders[oldId].chats.filter(c => c !== k);
    }
    if (folderId && s.folders[folderId]) {
        if (!s.folders[folderId].chats.includes(k)) s.folders[folderId].chats.push(k);
        s.chatFolder[k] = folderId;
    } else {
        delete s.chatFolder[k];
    }
    saveSettings();
}

function getFolderForChat(fileName) {
    const s = getSettings();
    const k = chatKey(fileName);
    if (!k) return null;
    const id = s.chatFolder[k];
    return (id && s.folders[id]) ? s.folders[id] : null;
}

function renderCurrentTags() {
    const container = document.getElementById('scm_current_tags');
    if (!container) return;
    container.innerHTML = '';

    const fileName = getCurrentChatId();
    if (!fileName) return;

    const tags = getTags(fileName);
    if (tags.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'scm-tag-empty';
        empty.textContent = t('pc_no_tags');
        container.appendChild(empty);
        return;
    }

    for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = 'scm-tag-chip';
        chip.style.background = colorForTag(tag);
        chip.textContent = tag;

        const x = document.createElement('span');
        x.className = 'scm-tag-x';
        x.textContent = '×';
        x.title = 'Remove';
        x.addEventListener('click', () => {
            removeTag(fileName, tag);
            renderCurrentTags();
            refreshPastChatsBadges();
        });
        chip.appendChild(x);
        container.appendChild(chip);
    }
}

async function runAutoTag() {
    const fileName = getCurrentChatId();
    if (!fileName) {
        toastr.info(t('toast_no_chat'));
        return;
    }
    const transcript = buildRecentTranscript(20);
    if (!transcript) {
        toastr.info(t('toast_no_chat'));
        return;
    }

    toastr.info(t('toast_tagging'));
    let raw;
    try {
        const s = getSettings();
        raw = await generate({
            promptId: s.autoTag.promptId,
            transcript,
            maxTokens: 60,
        });
    } catch (err) {
        console.error(`[${MODULE_NAME}] auto-tag failed`, err);
        toastr.error(t('toast_failed') + (err.message || err));
        return;
    }

    const newTags = raw
        .split(/[,\n]/)
        .map(x => x.trim().toLowerCase().replace(/^[#*\-•\s]+|[.?!\s]+$/g, ''))
        .filter(x => x.length > 0 && x.length <= 32)
        .slice(0, 5);

    if (newTags.length === 0) {
        toastr.warning(t('toast_failed') + 'empty response');
        return;
    }

    setTags(fileName, [...getTags(fileName), ...newTags]);
    renderCurrentTags();
    refreshPastChatsBadges();
    toastr.success(t('toast_done'));
}

/* ------------------------------------------------------------------
 *  Past Chats UI overhaul
 * ------------------------------------------------------------------ */

function colorForTag(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 55%, 38%)`;
}

function injectPastChatsToolbar() {
    const header = document.querySelector('#select_chat_popup [name="selectChatPopupHeader"]');
    if (!header || document.getElementById('scm_pc_toolbar')) return;

    const s = getSettings();

    const bar = document.createElement('div');
    bar.id = 'scm_pc_toolbar';
    bar.className = 'flex-container alignitemscenter flexGap10 wide100p';
    bar.innerHTML = `
        <input type="search" id="scm_pc_tag_search" class="text_pole flex1"
               placeholder="${escapeHtml(t('pc_search_placeholder'))}"
               value="${escapeHtml(s.tagSearch)}" autocomplete="off" />
        <label for="scm_pc_sort">${escapeHtml(t('pc_sort_label'))}</label>
        <select id="scm_pc_sort" class="text_pole">
            <option value="last_mes">${escapeHtml(t('pc_sort_last_mes'))}</option>
            <option value="created">${escapeHtml(t('pc_sort_created'))}</option>
            <option value="alpha">${escapeHtml(t('pc_sort_alpha'))}</option>
        </select>
        <input id="scm_pc_new_folder" class="menu_button" type="button"
               value="${escapeHtml(t('folder_new'))}" />
    `;
    header.parentElement.insertBefore(bar, header.nextSibling);
    bar.querySelector('#scm_pc_sort').value = s.sort;

    bar.querySelector('#scm_pc_tag_search').addEventListener('input', (e) => {
        s.tagSearch = e.target.value;
        saveSettings();
        applyPastChatsFilterAndSort();
    });
    bar.querySelector('#scm_pc_sort').addEventListener('change', (e) => {
        s.sort = e.target.value;
        saveSettings();
        applyPastChatsFilterAndSort();
    });
    bar.querySelector('#scm_pc_new_folder').addEventListener('click', async () => {
        const nm = await callGenericPopup(t('folder_name_prompt'), POPUP_TYPE.INPUT, '');
        if (typeof nm !== 'string' || !nm.trim()) return;
        createFolder(nm);
        applyPastChatsFilterAndSort();
    });
}

function refreshPastChatsBadges() {
    const blocks = document.querySelectorAll('#select_chat_div .select_chat_block');
    blocks.forEach((block) => {
        const fileName = block.getAttribute('file_name');
        if (!fileName) return;

        const wrapper = block.closest('.select_chat_block_wrapper') || block;
        wrapper.querySelectorAll('.scm-badge-row').forEach(n => n.remove());

        const tags = getTags(fileName);

        const row = document.createElement('div');
        row.className = 'scm-badge-row';

        // Folder move button — always present, even with no tags.
        const moveBtn = document.createElement('span');
        moveBtn.className = 'scm-move-btn';
        moveBtn.title = t('folder_move_title');
        moveBtn.innerHTML = '<i class="fa-solid fa-folder-tree"></i>';
        moveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openFolderPickerForChat(fileName).catch(err =>
                console.error(`[${MODULE_NAME}] folder picker failed`, err));
        });
        row.appendChild(moveBtn);

        for (const tag of tags) {
            const badge = document.createElement('span');
            badge.className = 'scm-badge';
            badge.style.background = colorForTag(tag);
            badge.textContent = tag;
            row.appendChild(badge);
        }

        const mes = block.querySelector('.select_chat_block_mes');
        if (mes && mes.parentElement) {
            mes.parentElement.insertBefore(row, mes.nextSibling);
        } else {
            block.appendChild(row);
        }
    });
}

function applyPastChatsFilterAndSort() {
    const list = document.getElementById('select_chat_div');
    if (!list) return;
    const s = getSettings();
    const query = s.tagSearch.trim().toLowerCase();
    const terms = query.split(/[\s,]+/).filter(Boolean);

    // Mark the whole pass as ours so the MutationObserver ignores all the
    // DOM churn from teardown + re-render. Without this, the teardown phase
    // would loop the observer at 60fps via requestAnimationFrame.
    list.dataset.scmRendering = '1';
    try {
        // Tear down any prior folder scaffolding so we can re-flatten the list.
        list.querySelectorAll('.scm-folder-group').forEach(group => {
            const body = group.querySelector('.scm-folder-body');
            if (body) {
                while (body.firstChild) list.appendChild(body.firstChild);
            }
            group.remove();
        });

        const wrappers = Array.from(list.querySelectorAll('.select_chat_block_wrapper'));
        wrappers.forEach((w) => {
            const fileName = w.querySelector('.select_chat_block')?.getAttribute('file_name') || '';
            const tags = getTags(fileName);
            const visible = terms.length === 0
                ? true
                : terms.every(term => tags.some(tag => tag.includes(term)));
            w.style.display = visible ? '' : 'none';
        });

        const visibleWrappers = wrappers.filter(w => w.style.display !== 'none');
        visibleWrappers.sort((a, b) => sortChatBlocks(a, b, s.sort));

        // Append in sort order, then wrap into folder groups.
        visibleWrappers.forEach(w => list.appendChild(w));
        applyFolderGrouping(visibleWrappers, list, terms.length > 0);
    } finally {
        delete list.dataset.scmRendering;
    }
}

function applyFolderGrouping(visibleWrappers, list, isFiltering) {
    const s = getSettings();
    const folderIds = Object.keys(s.folders).sort((a, b) =>
        s.folders[a].name.localeCompare(s.folders[b].name));
    if (folderIds.length === 0) return;

    const buckets = new Map();
    for (const w of visibleWrappers) {
        const fileName = w.querySelector('.select_chat_block')?.getAttribute('file_name') || '';
        const k = chatKey(fileName);
        const fid = s.chatFolder[k];
        if (fid && s.folders[fid]) {
            if (!buckets.has(fid)) buckets.set(fid, []);
            buckets.get(fid).push(w);
        }
    }

    const frag = document.createDocumentFragment();
    for (const fid of folderIds) {
        const folder = s.folders[fid];
        const members = buckets.get(fid) || [];
        // Hide empty folders entirely while a tag filter is active; otherwise
        // keep them visible so the user can drop chats in.
        if (members.length === 0 && isFiltering) continue;

        const group = document.createElement('div');
        group.className = 'scm-folder-group';
        group.dataset.folderId = fid;

        const header = buildFolderHeader(folder, members.length);
        const body = document.createElement('div');
        body.className = 'scm-folder-body';
        if (folder.collapsed) body.hidden = true;
        for (const w of members) body.appendChild(w);

        group.appendChild(header);
        group.appendChild(body);
        frag.appendChild(group);
    }
    // Folder groups go above ungrouped chats (which remain in document order).
    list.insertBefore(frag, list.firstChild);
}

function buildFolderHeader(folder, visibleCount) {
    const h = document.createElement('div');
    h.className = 'scm-folder-header';
    h.dataset.folderId = folder.id;

    const tog = document.createElement('span');
    tog.className = 'scm-folder-toggle';
    tog.textContent = folder.collapsed ? '▶' : '▼';
    h.appendChild(tog);

    const ic = document.createElement('i');
    ic.className = 'fa-solid fa-folder';
    h.appendChild(ic);

    const name = document.createElement('span');
    name.className = 'scm-folder-name';
    name.textContent = folder.name;
    h.appendChild(name);

    const cnt = document.createElement('span');
    cnt.className = 'scm-folder-count';
    cnt.textContent = `(${visibleCount})`;
    h.appendChild(cnt);

    const ren = document.createElement('span');
    ren.className = 'scm-folder-act fa-solid fa-pen';
    ren.title = t('folder_rename');
    h.appendChild(ren);

    const del = document.createElement('span');
    del.className = 'scm-folder-act fa-solid fa-xmark';
    del.title = t('folder_delete');
    h.appendChild(del);

    h.addEventListener('click', () => {
        const s = getSettings();
        if (!s.folders[folder.id]) return;
        s.folders[folder.id].collapsed = !s.folders[folder.id].collapsed;
        saveSettings();
        applyPastChatsFilterAndSort();
    });

    ren.addEventListener('click', async (e) => {
        e.stopPropagation();
        const v = await callGenericPopup(t('folder_name_prompt'), POPUP_TYPE.INPUT, folder.name);
        if (typeof v === 'string' && v.trim()) {
            renameFolder(folder.id, v);
            applyPastChatsFilterAndSort();
        }
    });

    del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await callGenericPopup(t('folder_delete_confirm'), POPUP_TYPE.CONFIRM);
        if (ok === POPUP_RESULT.AFFIRMATIVE) {
            deleteFolder(folder.id);
            applyPastChatsFilterAndSort();
        }
    });

    return h;
}

async function openFolderPickerForChat(fileName) {
    const s = getSettings();
    const k = chatKey(fileName);
    if (!k) return;
    const currentFid = s.chatFolder[k] || '';

    const opts = [`<option value="">— ${escapeHtml(t('folder_none'))} —</option>`];
    const sortedIds = Object.keys(s.folders).sort((a, b) =>
        s.folders[a].name.localeCompare(s.folders[b].name));
    for (const id of sortedIds) {
        const sel = id === currentFid ? ' selected' : '';
        opts.push(`<option value="${escapeHtml(id)}"${sel}>${escapeHtml(s.folders[id].name)}</option>`);
    }
    opts.push(`<option value="__new__">+ ${escapeHtml(t('folder_new'))}</option>`);

    const html = `
        <div class="scm-move-root">
            <h3>${escapeHtml(t('folder_move_title'))}</h3>
            <div class="scm-hint">${escapeHtml(fileName)}</div>
            <label for="scm_move_select">${escapeHtml(t('folder_move_select_label'))}</label>
            <select id="scm_move_select" class="text_pole" style="width:100%;">${opts.join('')}</select>
        </div>
    `;

    // Open the popup, then capture the select value via a change handler so
    // we still have it after the popup DOM is torn down on close.
    const popupPromise = callGenericPopup(html, POPUP_TYPE.CONFIRM);
    let chosen = currentFid;
    await new Promise(r => setTimeout(r, 0));
    const $sel = document.getElementById('scm_move_select');
    if ($sel) {
        chosen = $sel.value;
        $sel.addEventListener('change', () => { chosen = $sel.value; });
    }
    const result = await popupPromise;
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    if (chosen === '__new__') {
        const nm = await callGenericPopup(t('folder_name_prompt'), POPUP_TYPE.INPUT, '');
        if (typeof nm !== 'string' || !nm.trim()) return;
        chosen = createFolder(nm);
    }
    moveChatToFolder(fileName, chosen || null);
    applyPastChatsFilterAndSort();
}

function sortChatBlocks(a, b, sortKey) {
    const aName = a.querySelector('.select_chat_block')?.getAttribute('file_name') || '';
    const bName = b.querySelector('.select_chat_block')?.getAttribute('file_name') || '';

    if (sortKey === 'alpha') return aName.localeCompare(bName);

    if (sortKey === 'created') {
        const re = /(\d{4})-(\d{1,2})-(\d{1,2})[ _]?@?(\d{1,2})h[ _]?(\d{1,2})m(?:(\d{1,2})s)?(?:(\d{1,3})ms)?/;
        const aT = aName.match(re);
        const bT = bName.match(re);
        if (aT && bT) {
            const aKey = Date.UTC(+aT[1], +aT[2] - 1, +aT[3], +aT[4], +aT[5], +(aT[6] || 0), +(aT[7] || 0));
            const bKey = Date.UTC(+bT[1], +bT[2] - 1, +bT[3], +bT[4], +bT[5], +(bT[6] || 0), +(bT[7] || 0));
            return bKey - aKey;
        }
        return aName.localeCompare(bName);
    }
    return 0; // last_mes — preserve ST's existing order (already sorted server-side).
}

/* ------------------------------------------------------------------
 *  Prompt Library — selectors + modal editor
 * ------------------------------------------------------------------ */

function getPromptsByType(type) {
    const s = getSettings();
    return Object.values(s.prompts).filter(p => p.type === type);
}

function refreshPromptSelectors() {
    const s = getSettings();
    const namingSel = document.getElementById('scm_naming_prompt');
    const tagSel = document.getElementById('scm_tagging_prompt');
    if (!namingSel || !tagSel) return;

    const fill = (sel, type, currentId) => {
        sel.innerHTML = '';
        for (const p of getPromptsByType(type)) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name + (p.builtIn ? '' : ' *');
            sel.appendChild(opt);
        }
        sel.value = currentId;
        // If the previously selected prompt was deleted, fall back
        // to the first available one of that type.
        if (sel.value !== currentId) {
            const fallback = getPromptsByType(type)[0];
            if (fallback) {
                sel.value = fallback.id;
                if (type === 'naming') s.autoName.promptId = fallback.id;
                else s.autoTag.promptId = fallback.id;
                saveSettings();
            }
        }
    };

    fill(namingSel, 'naming', s.autoName.promptId);
    fill(tagSel, 'tagging', s.autoTag.promptId);
}

async function openPromptManager() {
    const s = getSettings();

    const html = `
        <div id="scm_pm_root" class="scm-pm-root">
            <h3>${escapeHtml(t('pm_modal_title'))}</h3>

            <div class="scm-pm-toolbar flex-container">
                <label for="scm_pm_select" class="scm-pm-label">${escapeHtml(t('pm_select_prompt'))}</label>
                <select id="scm_pm_select" class="text_pole flex1"></select>
                <input id="scm_pm_new" type="button" class="menu_button" value="${escapeHtml(t('pm_new'))}" />
                <input id="scm_pm_delete" type="button" class="menu_button" value="${escapeHtml(t('pm_delete'))}" />
                <input id="scm_pm_reset" type="button" class="menu_button" value="${escapeHtml(t('pm_reset'))}" />
            </div>

            <div class="scm-pm-form">
                <label for="scm_pm_name">${escapeHtml(t('pm_name'))}</label>
                <input id="scm_pm_name" type="text" class="text_pole" />

                <label for="scm_pm_type">${escapeHtml(t('pm_type'))}</label>
                <select id="scm_pm_type" class="text_pole">
                    <option value="naming">${escapeHtml(t('pm_type_naming'))}</option>
                    <option value="tagging">${escapeHtml(t('pm_type_tagging'))}</option>
                </select>

                <label for="scm_pm_system">${escapeHtml(t('pm_system_prompt'))}</label>
                <textarea id="scm_pm_system" class="text_pole scm-pm-textarea" rows="14"></textarea>

                <small class="scm-hint">${escapeHtml(t('pm_builtin_locked'))}</small>

                <div class="flex-container">
                    <input id="scm_pm_save" type="button" class="menu_button" value="${escapeHtml(t('pm_save'))}" />
                </div>
            </div>
        </div>
    `;

    // Open as a non-blocking display popup; we'll close it manually.
    const popupPromise = callGenericPopup(html, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    // Wait one tick for the popup DOM to mount, then bind.
    await new Promise(r => setTimeout(r, 0));

    let currentId = s.autoName.promptId in s.prompts ? s.autoName.promptId : Object.keys(s.prompts)[0];

    const $select = document.getElementById('scm_pm_select');
    const $name = document.getElementById('scm_pm_name');
    const $type = document.getElementById('scm_pm_type');
    const $system = document.getElementById('scm_pm_system');
    const $save = document.getElementById('scm_pm_save');
    const $new = document.getElementById('scm_pm_new');
    const $del = document.getElementById('scm_pm_delete');
    const $reset = document.getElementById('scm_pm_reset');

    function refreshSelect() {
        $select.innerHTML = '';
        for (const p of Object.values(s.prompts)) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `[${p.type}] ${p.name}` + (p.builtIn ? ' (built-in)' : '');
            $select.appendChild(opt);
        }
        $select.value = currentId;
    }

    function loadIntoForm(id) {
        const p = s.prompts[id];
        if (!p) return;
        currentId = id;
        $name.value = p.name;
        $name.disabled = !!p.builtIn;
        $type.value = p.type;
        $type.disabled = !!p.builtIn;
        $system.value = p.systemPrompt;
        $del.disabled = !!p.builtIn;
        $reset.style.display = p.builtIn ? '' : 'none';
    }

    refreshSelect();
    loadIntoForm(currentId);

    $select.addEventListener('change', (e) => loadIntoForm(e.target.value));

    $save.addEventListener('click', () => {
        const p = s.prompts[currentId];
        if (!p) return;
        if (!p.builtIn) {
            p.name = $name.value.trim() || p.name;
            p.type = $type.value;
        }
        p.systemPrompt = $system.value;
        saveSettings();
        refreshSelect();
        refreshPromptSelectors();
        toastr.success(t('toast_saved'));
    });

    $new.addEventListener('click', () => {
        const id = uid();
        const p = {
            id,
            name: t('pm_new_name_default'),
            type: $type.value || 'naming',
            builtIn: false,
            systemPrompt: '',
        };
        s.prompts[id] = p;
        currentId = id;
        saveSettings();
        refreshSelect();
        loadIntoForm(id);
        refreshPromptSelectors();
    });

    $del.addEventListener('click', async () => {
        const p = s.prompts[currentId];
        if (!p || p.builtIn) return;
        if (s.autoName.promptId === p.id || s.autoTag.promptId === p.id) {
            toastr.warning(t('pm_in_use'));
            return;
        }
        const ok = await callGenericPopup(t('pm_confirm_delete'), POPUP_TYPE.CONFIRM);
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        delete s.prompts[currentId];
        const remaining = Object.keys(s.prompts);
        currentId = remaining[0];
        saveSettings();
        refreshSelect();
        loadIntoForm(currentId);
        refreshPromptSelectors();
    });

    $reset.addEventListener('click', () => {
        const p = s.prompts[currentId];
        if (!p || !p.builtIn) return;
        const def = DEFAULT_PROMPTS[p.id];
        if (!def) return;
        p.systemPrompt = def.systemPrompt;
        p.name = def.name;
        saveSettings();
        loadIntoForm(p.id);
        refreshSelect();
        refreshPromptSelectors();
        toastr.success(t('toast_saved'));
    });

    await popupPromise;
}

/* ------------------------------------------------------------------
 *  API profile manager (inline, in the settings panel)
 * ------------------------------------------------------------------ */

function refreshProfileSelector() {
    const s = getSettings();
    const $select = document.getElementById('scm_profile_select');
    if (!$select) return;

    $select.innerHTML = '';
    if (s.api.profiles.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = t('api_no_profiles');
        $select.appendChild(opt);
    } else {
        for (const p of s.api.profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            $select.appendChild(opt);
        }
    }

    if (!s.api.profiles.find(p => p.id === s.api.activeProfileId)) {
        s.api.activeProfileId = s.api.profiles[0]?.id || null;
    }
    if (s.api.activeProfileId) {
        $select.value = s.api.activeProfileId;
        loadProfileIntoForm(s.api.activeProfileId);
    } else {
        clearProfileForm();
    }
}

function loadProfileIntoForm(id) {
    const s = getSettings();
    const p = s.api.profiles.find(x => x.id === id);
    if (!p) return clearProfileForm();
    document.getElementById('scm_profile_name').value = p.name || '';
    document.getElementById('scm_custom_url').value = p.url || '';
    document.getElementById('scm_custom_key').value = p.key || '';
    document.getElementById('scm_custom_model').value = p.model || '';
}

function clearProfileForm() {
    ['scm_profile_name', 'scm_custom_url', 'scm_custom_key', 'scm_custom_model']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function bindProfileManager() {
    const s = getSettings();

    const $select = document.getElementById('scm_profile_select');
    $select.addEventListener('change', (e) => {
        s.api.activeProfileId = e.target.value || null;
        saveSettings();
        loadProfileIntoForm(s.api.activeProfileId);
    });

    document.getElementById('scm_profile_new').addEventListener('click', () => {
        const id = uid();
        const newProfile = {
            id,
            name: `${t('api_profile_default')} ${s.api.profiles.length + 1}`,
            url: '',
            key: '',
            model: '',
        };
        s.api.profiles.push(newProfile);
        s.api.activeProfileId = id;
        saveSettings();
        refreshProfileSelector();
    });

    document.getElementById('scm_profile_delete').addEventListener('click', async () => {
        if (!s.api.activeProfileId) return;
        const ok = await callGenericPopup(t('api_confirm_delete'), POPUP_TYPE.CONFIRM);
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        s.api.profiles = s.api.profiles.filter(p => p.id !== s.api.activeProfileId);
        s.api.activeProfileId = s.api.profiles[0]?.id || null;
        saveSettings();
        refreshProfileSelector();
    });

    document.getElementById('scm_profile_save').addEventListener('click', () => {
        if (!s.api.activeProfileId) {
            // No profile yet — create one from the form fields.
            document.getElementById('scm_profile_new').click();
        }
        const p = s.api.profiles.find(x => x.id === s.api.activeProfileId);
        if (!p) return;
        p.name = document.getElementById('scm_profile_name').value.trim() || p.name;
        p.url = document.getElementById('scm_custom_url').value.trim();
        p.key = document.getElementById('scm_custom_key').value;
        p.model = document.getElementById('scm_custom_model').value.trim();
        saveSettings();
        refreshProfileSelector();
        toastr.success(t('toast_saved'));
    });
}

/* ------------------------------------------------------------------
 *  Settings panel wiring
 * ------------------------------------------------------------------ */

function bindSettingsPanel() {
    const s = getSettings();

    // Language
    const lang = document.getElementById('scm_language');
    lang.value = s.language;
    lang.addEventListener('change', (e) => {
        s.language = e.target.value;
        saveSettings();
        applyTranslations(document);
        renderCurrentTags();
        refreshPromptSelectors();
        refreshProfileSelector();
        document.getElementById('scm_pc_toolbar')?.remove();
        if (document.getElementById('shadow_select_chat_popup')?.style.display !== 'none') {
            injectPastChatsToolbar();
        }
    });

    // Auto-name
    const enabled = document.getElementById('scm_auto_name_enabled');
    enabled.checked = !!s.autoName.enabled;
    enabled.addEventListener('change', (e) => {
        s.autoName.enabled = e.target.checked;
        saveSettings();
    });

    const threshold = document.getElementById('scm_auto_name_threshold');
    threshold.value = s.autoName.threshold;
    threshold.addEventListener('change', (e) => {
        const v = Math.max(2, Math.min(100, parseInt(e.target.value, 10) || 6));
        s.autoName.threshold = v;
        e.target.value = v;
        saveSettings();
    });

    const confirmCb = document.getElementById('scm_auto_name_confirm');
    confirmCb.checked = !!s.autoName.confirm;
    confirmCb.addEventListener('change', (e) => {
        s.autoName.confirm = e.target.checked;
        saveSettings();
    });

    document.getElementById('scm_naming_prompt').addEventListener('change', (e) => {
        s.autoName.promptId = e.target.value;
        saveSettings();
    });

    document.getElementById('scm_manual_rename')
        .addEventListener('click', () => runAutoName({ force: true }));

    // Tag manager
    const newTag = document.getElementById('scm_new_tag');
    document.getElementById('scm_add_tag').addEventListener('click', () => {
        const fileName = getCurrentChatId();
        if (!fileName) { toastr.info(t('toast_no_chat')); return; }
        const v = newTag.value;
        if (!v.trim()) return;
        addTag(fileName, v);
        newTag.value = '';
        renderCurrentTags();
        refreshPastChatsBadges();
    });
    newTag.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('scm_add_tag').click();
        }
    });
    document.getElementById('scm_auto_tag').addEventListener('click', runAutoTag);

    document.getElementById('scm_tagging_prompt').addEventListener('change', (e) => {
        s.autoTag.promptId = e.target.value;
        saveSettings();
    });

    // Prompt manager
    document.getElementById('scm_open_prompt_manager').addEventListener('click', () => {
        openPromptManager().catch(err => console.error(`[${MODULE_NAME}]`, err));
    });

    // API source
    const source = document.getElementById('scm_api_source');
    source.value = s.api.source;
    const customBlock = document.getElementById('scm_custom_api_block');
    const toggleCustomBlock = () => {
        customBlock.style.display = (s.api.source === 'custom') ? '' : 'none';
    };
    toggleCustomBlock();
    source.addEventListener('change', (e) => {
        s.api.source = e.target.value;
        saveSettings();
        toggleCustomBlock();
    });

    // Completion mode
    const mode = document.getElementById('scm_completion_mode');
    mode.value = s.api.completionMode;
    mode.addEventListener('change', (e) => {
        s.api.completionMode = e.target.value;
        saveSettings();
    });

    // Rotate
    const rotate = document.getElementById('scm_api_rotate');
    rotate.checked = !!s.api.rotate;
    rotate.addEventListener('change', (e) => {
        s.api.rotate = e.target.checked;
        saveSettings();
    });

    // Profiles
    bindProfileManager();

    // Reset
    document.getElementById('scm_reset_all').addEventListener('click', () => {
        runResetFlow().catch(err => console.error(`[${MODULE_NAME}] reset failed`, err));
    });
}

async function runResetFlow() {
    const html1 = `
        <h3>${escapeHtml(t('reset_confirm_1_title'))}</h3>
        <p>${escapeHtml(t('reset_confirm_1_body'))}</p>
    `;
    const r1 = await callGenericPopup(html1, POPUP_TYPE.CONFIRM);
    if (r1 !== POPUP_RESULT.AFFIRMATIVE) return;

    const html2 = `
        <h3>${escapeHtml(t('reset_confirm_2_title'))}</h3>
        <p><b>${escapeHtml(t('reset_confirm_2_body'))}</b></p>
    `;
    const r2 = await callGenericPopup(html2, POPUP_TYPE.CONFIRM);
    if (r2 !== POPUP_RESULT.AFFIRMATIVE) return;

    resetExtension();
}

function resetExtension() {
    extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    saveSettingsDebounced();

    // Reload to guarantee every cached UI surface reflects the wiped state
    // — settings panel inputs, past-chats toolbar, observers, branchPromptedFor,
    // the lot. The double-confirm above gates this hard reset.
    toastr.success(t('reset_done'));
    setTimeout(() => location.reload(), 400);
}

/* ------------------------------------------------------------------
 *  Event wiring
 * ------------------------------------------------------------------ */

function onMessageEvent() {
    const s = getSettings();
    if (!s.autoName.enabled) return;
    const fileName = getCurrentChatId();
    if (!fileName) return;
    if (s.autoNamed[fileName]) return;
    if (!Array.isArray(currentChat)) return;
    if (currentChat.length < s.autoName.threshold) return;
    runAutoName().catch(err => console.error(`[${MODULE_NAME}]`, err));
}

function onChatChanged() {
    renderCurrentTags();
    maybePromptBranchFolder().catch(err =>
        console.error(`[${MODULE_NAME}] branch folder prompt failed`, err));
}

async function maybePromptBranchFolder() {
    const s = getSettings();
    const branchName = getCurrentChatId();
    if (!branchName) return;

    const parentName = chat_metadata && chat_metadata.main_chat;
    if (!parentName) return; // not a branch

    const branchK = chatKey(branchName);
    const parentK = chatKey(parentName);
    if (!branchK || !parentK || branchK === parentK) return;
    if (s.branchPromptedFor.includes(branchK)) return;

    // Mark as handled FIRST so we don't double-prompt if events fire twice.
    s.branchPromptedFor.push(branchK);
    if (s.branchPromptedFor.length > 500) {
        s.branchPromptedFor.splice(0, s.branchPromptedFor.length - 500);
    }
    saveSettings();

    // Determine default folder name: reuse parent's folder if any, else
    // suggest a name derived from the parent chat.
    const parentFolderId = s.chatFolder[parentK];
    const parentFolder = parentFolderId && s.folders[parentFolderId] ? s.folders[parentFolderId] : null;
    const defaultName = parentFolder
        ? parentFolder.name
        : t('branch_default_folder_name').replace('{name}', parentK);

    const html = `
        <h3>${escapeHtml(t('branch_prompt_title'))}</h3>
        <p>${escapeHtml(t('branch_prompt_body'))}</p>
    `;
    const folderName = await callGenericPopup(html, POPUP_TYPE.INPUT, defaultName);
    if (typeof folderName !== 'string' || !folderName.trim()) return;

    let folderId = parentFolder
        ? parentFolderId
        : (function () {
            // If a folder with this exact name already exists, reuse it.
            const lower = folderName.trim().toLowerCase();
            for (const id of Object.keys(s.folders)) {
                if (s.folders[id].name.toLowerCase() === lower) return id;
            }
            return createFolder(folderName);
        })();

    if (parentFolder && parentFolder.name !== folderName.trim()) {
        renameFolder(folderId, folderName);
    }
    moveChatToFolder(parentName, folderId);
    moveChatToFolder(branchName, folderId);
}

/* ------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------ */

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function startPastChatsObserver() {
    const target = document.getElementById('select_chat_div');
    if (!target) return;
    let pending = false;
    new MutationObserver(() => {
        // Skip mutations that came from our own re-grouping pass.
        if (target.dataset.scmRendering === '1') return;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            refreshPastChatsBadges();
            applyPastChatsFilterAndSort();
        });
    }).observe(target, { childList: true, subtree: false });
}

function startPastChatsPopupObserver() {
    const shadow = document.getElementById('shadow_select_chat_popup');
    if (!shadow) return;
    new MutationObserver(() => {
        const visible = shadow.style.display !== 'none';
        if (visible) {
            injectPastChatsToolbar();
            setTimeout(() => {
                refreshPastChatsBadges();
                applyPastChatsFilterAndSort();
            }, 250);
        }
    }).observe(shadow, { attributes: true, attributeFilter: ['style', 'class'] });
}

/* ------------------------------------------------------------------
 *  Init
 * ------------------------------------------------------------------ */

jQuery(async () => {
    try {
        getSettings();

        // Inject the settings panel. We mount into #extensions_settings2,
        // falling back to #extensions_settings, then to <body> if neither
        // container exists yet (e.g. on a stripped-down ST build).
        const $host = $('#extensions_settings2').length
            ? $('#extensions_settings2')
            : ($('#extensions_settings').length ? $('#extensions_settings') : $('body'));
        $host.append(SETTINGS_HTML);

        // Verify the panel mounted before wiring handlers; if anything
        // upstream stripped it (e.g. a sanitizer), bail out cleanly.
        if (!document.getElementById('scm_settings')) {
            console.error(`[${MODULE_NAME}] settings panel failed to mount.`);
            return;
        }

        bindSettingsPanel();
        applyTranslations(document.getElementById('scm_settings'));
        refreshPromptSelectors();
        refreshProfileSelector();
        renderCurrentTags();

        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageEvent);
        eventSource.on(event_types.MESSAGE_SENT, onMessageEvent);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

        startPastChatsPopupObserver();
        startPastChatsObserver();

        console.log(`[${MODULE_NAME}] loaded.`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] init failed`, err);
    }
});
