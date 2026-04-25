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
    characters,
    this_chid,
    name1,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
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
const EXTENSION_FOLDER = 'third-party/SmartChatManager';

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

    tags: {},                        // { [chatFileName]: string[] }
    autoNamed: {},                   // { [chatFileName]: true }

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

function getTags(fileName) {
    const s = getSettings();
    return Array.isArray(s.tags[fileName]) ? s.tags[fileName] : [];
}

function setTags(fileName, tags) {
    const s = getSettings();
    const cleaned = Array.from(new Set(
        (tags || [])
            .map(x => String(x).trim().toLowerCase())
            .filter(x => x.length > 0 && x.length <= 32),
    ));
    if (cleaned.length === 0) {
        delete s.tags[fileName];
    } else {
        s.tags[fileName] = cleaned;
    }
    saveSettings();
}

function addTag(fileName, tag) {
    setTags(fileName, [...getTags(fileName), tag]);
}

function removeTag(fileName, tag) {
    setTags(fileName, getTags(fileName).filter(x => x !== tag));
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
}

function refreshPastChatsBadges() {
    const blocks = document.querySelectorAll('#select_chat_div .select_chat_block');
    blocks.forEach((block) => {
        const fileName = block.getAttribute('file_name');
        if (!fileName) return;

        const wrapper = block.closest('.select_chat_block_wrapper') || block;
        wrapper.querySelectorAll('.scm-badge-row').forEach(n => n.remove());

        const tags = getTags(fileName);
        if (tags.length === 0) return;

        const row = document.createElement('div');
        row.className = 'scm-badge-row';
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

    const wrappers = Array.from(list.querySelectorAll('.select_chat_block_wrapper'));
    const terms = query.split(/[\s,]+/).filter(Boolean);
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
    visibleWrappers.forEach(w => list.appendChild(w));
}

function sortChatBlocks(a, b, sortKey) {
    const aName = a.querySelector('.select_chat_block')?.getAttribute('file_name') || '';
    const bName = b.querySelector('.select_chat_block')?.getAttribute('file_name') || '';

    if (sortKey === 'alpha') return aName.localeCompare(bName);

    if (sortKey === 'created') {
        const re = /(\d{4})-(\d{2})-(\d{2})[\s_]@?(\d{1,2})h[\s_]?(\d{1,2})m/;
        const aT = aName.match(re);
        const bT = bName.match(re);
        if (aT && bT) {
            const aKey = aT.slice(1).map(Number).reduce((acc, v) => acc * 100 + v, 0);
            const bKey = bT.slice(1).map(Number).reduce((acc, v) => acc * 100 + v, 0);
            return bKey - aKey;
        }
        return aName.localeCompare(bName);
    }
    return 0; // last_mes — preserve ST's existing order
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

        const html = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
        $('#extensions_settings2').append(html);

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
