import GLib from 'gi://GLib';

const _strings = {
    // Extension UI
    'clipboard-empty':      { en: 'Clipboard is empty',            zh_CN: '剪贴板为空' },
    'clear-history':        { en: 'Clear history',                 zh_CN: '清空历史' },
    'settings':             { en: 'Settings',                      zh_CN: '设置' },
    'image':                { en: 'Image',                         zh_CN: '图片' },

    // Sync status
    'sync-connected':       { en: 'MountLink: Connected',          zh_CN: 'MountLink: 已连接' },
    'sync-listening':       { en: 'MountLink: Listening',          zh_CN: 'MountLink: 监听中' },
    'sync-disconnected':    { en: 'MountLink: Disconnected',       zh_CN: 'MountLink: 未连接' },
    'sync-connecting':      { en: 'MountLink: Connecting...',      zh_CN: 'MountLink: 连接中...' },
    'sync-disabled':        { en: 'MountLink: Sync disabled',      zh_CN: 'MountLink: 同步已禁用' },

    // Prefs - groups
    'general':              { en: 'General',                       zh_CN: '常规' },
    'sync-group':           { en: 'MountLink Sync',                zh_CN: 'MountLink 同步' },
    'shortcuts-group':      { en: 'Shortcuts',                     zh_CN: '快捷键' },

    // Prefs - general
    'history-size':         { en: 'History size',                  zh_CN: '历史条数' },
    'preview-size':         { en: 'Preview length (characters)',   zh_CN: '预览长度（字符）' },
    'max-cache-size':       { en: 'Max cache size (MB)',           zh_CN: '最大缓存大小 (MB)' },
    'auto-clear':           { en: 'Auto clear interval',           zh_CN: '自动清除间隔' },
    'paste-on-select':      { en: 'Paste on select',              zh_CN: '选中即粘贴' },
    'language':             { en: 'Language',                      zh_CN: '语言' },
    'lang-restart-note':    { en: 'Reopen settings to apply',     zh_CN: '重新打开设置页面后生效' },

    // Prefs - auto clear options
    'off':                  { en: 'Off',                           zh_CN: '关闭' },
    'hours-24':             { en: '24 hours',                      zh_CN: '24 小时' },
    'hours-48':             { en: '48 hours',                      zh_CN: '48 小时' },
    'hours-96':             { en: '96 hours',                      zh_CN: '96 小时' },

    // Prefs - sync
    'sync-enabled':         { en: 'Enable MountLink sync (D-Bus)', zh_CN: '启用 MountLink 同步 (D-Bus)' },

    // Prefs - shortcuts
    'enable-shortcuts':     { en: 'Enable shortcuts',             zh_CN: '启用快捷键' },
    'toggle-menu':          { en: 'Toggle clipboard menu',        zh_CN: '切换剪贴板菜单' },
    'disabled':             { en: 'Disabled',                     zh_CN: '已禁用' },
    'enter-shortcut':       { en: 'Enter shortcut',               zh_CN: '输入快捷键' },

    // Language options
    'follow-system':        { en: 'Follow system',                zh_CN: '跟随系统' },

    // Prefs - logging
    'logging-group':        { en: 'Logging',                      zh_CN: '日志' },
    'enable-logging':       { en: 'Enable file logging',          zh_CN: '启用文件日志' },
    'enable-logging-desc':  { en: 'Write debug logs to ~/.cache/', zh_CN: '将调试日志写入 ~/.cache/' },
    'open-log-folder':      { en: 'Open log folder',              zh_CN: '打开日志目录' },
    'no-log-yet':           { en: 'No log files yet',             zh_CN: '暂无日志文件' },
};

let _lang = null;
let _detectedLang = null;

export function setLanguage (lang) {
    _lang = lang;
    _detectedLang = null; // reset cache when language setting changes
}

export function detectLanguage () {
    if (_detectedLang) return _detectedLang;
    try {
        const langs = GLib.get_language_names();
        for (const l of langs) {
            if (l.startsWith('zh')) { _detectedLang = 'zh_CN'; return _detectedLang; }
        }
    } catch (e) { /* ignore */ }
    _detectedLang = 'en';
    return _detectedLang;
}

export function tr (key) {
    const entry = _strings[key];
    if (!entry) return key;
    const lang = (!_lang || _lang === 'system') ? detectLanguage() : _lang;
    return entry[lang] || entry['en'] || key;
}
