import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { PrefsFields } from './constants.js';
import { tr, setLanguage } from './locale.js';

export default class ClipboardIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow (window) {
        const settings = this.getSettings();
        setLanguage(settings.get_string(PrefsFields.LANGUAGE));

        const page = new Adw.PreferencesPage();

        // ════════════ General ════════════
        const general = new Adw.PreferencesGroup({ title: tr('general') });

        const historySize = new Adw.SpinRow({
            title: tr('history-size'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 500, step_increment: 1
            })
        });
        settings.bind(PrefsFields.HISTORY_SIZE, historySize, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(historySize);

        const previewSize = new Adw.SpinRow({
            title: tr('preview-size'),
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 200, step_increment: 5
            })
        });
        settings.bind(PrefsFields.PREVIEW_SIZE, previewSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(previewSize);

        const cacheSize = new Adw.SpinRow({
            title: tr('max-cache-size'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 50, step_increment: 1
            })
        });
        settings.bind(PrefsFields.CACHE_FILE_SIZE, cacheSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(cacheSize);

        // Auto clear combo: Off / 24h / 48h / 96h
        const autoClear = new Adw.ComboRow({
            title: tr('auto-clear'),
            model: (() => {
                const list = new Gtk.StringList();
                [tr('off'), tr('hours-24'), tr('hours-48'), tr('hours-96')]
                    .forEach(s => list.append(s));
                return list;
            })()
        });
        const hoursToIdx = { 0: 0, 24: 1, 48: 2, 96: 3 };
        const idxToHours = [0, 24, 48, 96];
        autoClear.set_selected(hoursToIdx[settings.get_int(PrefsFields.AUTO_CLEAR_HOURS)] ?? 0);
        autoClear.connect('notify::selected', () => {
            settings.set_int(PrefsFields.AUTO_CLEAR_HOURS, idxToHours[autoClear.selected] ?? 0);
        });
        general.add(autoClear);

        const pasteOnSelect = new Adw.SwitchRow({ title: tr('paste-on-select') });
        settings.bind(PrefsFields.PASTE_ON_SELECT, pasteOnSelect, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(pasteOnSelect);

        // Language selector
        const langRow = new Adw.ComboRow({
            title: tr('language'),
            subtitle: tr('lang-restart-note'),
            model: (() => {
                const list = new Gtk.StringList();
                [tr('follow-system'), 'English', '简体中文'].forEach(s => list.append(s));
                return list;
            })()
        });
        const langToIdx = { 'system': 0, 'en': 1, 'zh_CN': 2 };
        const idxToLang = ['system', 'en', 'zh_CN'];
        langRow.set_selected(langToIdx[settings.get_string(PrefsFields.LANGUAGE)] ?? 0);
        langRow.connect('notify::selected', () => {
            settings.set_string(PrefsFields.LANGUAGE, idxToLang[langRow.selected] ?? 'system');
        });
        general.add(langRow);

        page.add(general);

        // ════════════ MountLink Sync ════════════
        const syncGroup = new Adw.PreferencesGroup({ title: tr('sync-group') });

        const syncEnabled = new Adw.SwitchRow({ title: tr('sync-enabled') });
        settings.bind(PrefsFields.SYNC_ENABLED, syncEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        syncGroup.add(syncEnabled);

        page.add(syncGroup);

        // ════════════ Shortcuts ════════════
        const shortcutsGroup = new Adw.PreferencesGroup({ title: tr('shortcuts-group') });

        const enableShortcuts = new Adw.SwitchRow({ title: tr('enable-shortcuts') });
        settings.bind(PrefsFields.ENABLE_KEYBINDING, enableShortcuts, 'active', Gio.SettingsBindFlags.DEFAULT);
        shortcutsGroup.add(enableShortcuts);

        const toggleMenuRow = new Adw.ActionRow({ title: tr('toggle-menu') });
        toggleMenuRow.add_suffix(this.#createShortcutButton(settings, PrefsFields.BINDING_TOGGLE_MENU));
        shortcutsGroup.add(toggleMenuRow);

        page.add(shortcutsGroup);

        // ════════════ Logging ════════════
        const loggingGroup = new Adw.PreferencesGroup({ title: tr('logging-group') });

        const enableLogging = new Adw.SwitchRow({
            title: tr('enable-logging'),
            subtitle: tr('enable-logging-desc')
        });
        settings.bind(PrefsFields.ENABLE_LOGGING, enableLogging, 'active', Gio.SettingsBindFlags.DEFAULT);
        loggingGroup.add(enableLogging);

        const openLogRow = new Adw.ActionRow({
            title: tr('open-log-folder'),
            activatable: true
        });
        openLogRow.add_suffix(new Gtk.Image({ icon_name: 'folder-open-symbolic' }));
        openLogRow.connect('activated', () => {
            const logDir = GLib.build_filenamev([
                GLib.get_user_cache_dir(), this.uuid, 'logs'
            ]);
            const dir = Gio.file_new_for_path(logDir);
            if (dir.query_exists(null)) {
                Gio.app_info_launch_default_for_uri(dir.get_uri(), null);
            } else {
                // Show a transient toast-like info — just log to console for now
                console.debug('Clipboard Indicator: no log folder yet at', logDir);
            }
        });
        loggingGroup.add(openLogRow);

        page.add(loggingGroup);

        window.add(page);
    }

    #createShortcutButton (settings, pref) {
        const button = new Gtk.Button({ has_frame: false });
        let _controller = null;
        let _connectId = null;
        let _debounceId = null;

        const updateLabel = () => {
            const val = settings.get_strv(pref)[0];
            button.set_label(val || tr('disabled'));
        };

        const cleanupController = () => {
            if (_debounceId) { clearTimeout(_debounceId); _debounceId = null; }
            if (_controller) {
                if (_connectId) { _controller.disconnect(_connectId); _connectId = null; }
                button.remove_controller(_controller);
                _controller = null;
            }
        };

        updateLabel();

        button.connect('clicked', () => {
            if (button._isEditing) {
                cleanupController();
                updateLabel();
                button._isEditing = false;
                return;
            }

            button._isEditing = true;
            button.set_label(tr('enter-shortcut'));

            cleanupController();
            _controller = new Gtk.EventControllerKey();
            button.add_controller(_controller);

            _connectId = _controller.connect('key-pressed', (_ec, keyval, keycode, mask) => {
                if (_debounceId) { clearTimeout(_debounceId); _debounceId = null; }
                mask = mask & Gtk.accelerator_get_default_mod_mask();

                if (mask === 0) {
                    if (keyval === Gdk.KEY_Escape) {
                        cleanupController();
                        updateLabel();
                        button._isEditing = false;
                        return Gdk.EVENT_STOP;
                    }
                    if (keyval === Gdk.KEY_BackSpace) {
                        settings.set_strv(pref, []);
                        cleanupController();
                        updateLabel();
                        button._isEditing = false;
                        return Gdk.EVENT_STOP;
                    }
                }

                const shortcut = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                _debounceId = setTimeout(() => {
                    _debounceId = null;
                    if (!button.get_parent()) return;   // widget already destroyed
                    cleanupController();
                    settings.set_strv(pref, [shortcut]);
                    updateLabel();
                    button._isEditing = false;
                }, 400);

                return Gdk.EVENT_STOP;
            });
        });

        return button;
    }
}
