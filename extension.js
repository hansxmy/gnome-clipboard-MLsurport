import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry, ClipboardEntry } from './registry.js';
import { PrefsFields } from './constants.js';
import { Keyboard } from './keyboard.js';
import { MountLinkSync } from './sync.js';
import { tr, setLanguage } from './locale.js';
import { Logger } from './logger.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
const INDICATOR_ICON = 'edit-paste-symbolic';

// Settings variables (module-level for fast access)
let MAX_REGISTRY_LENGTH = 50;
let MAX_ENTRY_LENGTH    = 50;
let PASTE_ON_SELECT     = false;
let ENABLE_KEYBINDING   = true;
let AUTO_CLEAR_HOURS    = 0;
let NEXT_CLEAR_TIME     = -1;
let SYNC_ENABLED        = true;
let MAX_CACHE_SIZE      = 5;
let ENABLE_LOGGING      = false;

export default class ClipboardIndicatorExtension extends Extension {
    enable () {
        this.clipboardIndicator = new ClipboardIndicator({
            clipboard: St.Clipboard.get_default(),
            settings: this.getSettings(),
            openSettings: this.openPreferences,
            uuid: this.uuid
        });
        Main.panel.addToStatusArea('clipboardIndicator', this.clipboardIndicator, 1);
    }

    disable () {
        this.clipboardIndicator.destroy();
        this.clipboardIndicator = null;
    }
}

const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator'
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;
    #lastReceivedHash = null;

    destroy () {
        this._destroyed = true;
        this.logger.info('Extension destroy called');
        this._flushCache();
        this._disconnectSettings();
        this._unbindShortcuts();
        this._disconnectSelectionListener();
        this.#clearTimeouts();
        this.keyboard.destroy();
        this.sync?.destroy();
        this.logger.destroy();
        super.destroy();
    }

    _init (extension) {
        super._init(0.0, 'ClipboardIndicator');
        this.extension = extension;
        this.registry = new Registry(extension.uuid);
        this.keyboard = new Keyboard();
        this.logger = new Logger(extension.uuid, ENABLE_LOGGING);
        this.clipItemsRadioGroup = [];
        this._shortcutsBindingIds = [];
        this._menuReady = false;

        // Load language first
        setLanguage(extension.settings.get_string(PrefsFields.LANGUAGE));

        // Top bar: icon only
        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });
        hbox.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        }));
        this.add_child(hbox);

        this._loadSettings();

        // Build menu async, then set up listeners
        this._buildMenu().then(() => {
            if (this._destroyed) return;
            this._setupListener();
            this._setupAutoClear();
            this._updateSyncStatus(this.sync?.state || 'disconnected');
            this.logger.info('Extension initialized, history:', this.clipItemsRadioGroup.length, 'items');
        }).catch(e => {
            console.error('Clipboard Indicator: menu build failed', e);
            this.logger.error('Menu build failed', e);
        });

        // Init sync module
        this._initSync();
    }

    // ──────────────────────── Menu Construction ────────────────────────

    async _buildMenu () {
        const clipHistory = await this.registry.read(MAX_REGISTRY_LENGTH, MAX_CACHE_SIZE);
        if (this._destroyed) return;

        // ── Status bar (MountLink connection) ──
        this._statusItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this._statusIcon = new St.Icon({
            icon_name: 'network-offline-symbolic',
            style_class: 'system-status-icon sync-status-icon'
        });
        this._statusLabel = new St.Label({
            text: tr('sync-disconnected'),
            style_class: 'sync-status-label',
            y_align: Clutter.ActorAlign.CENTER
        });
        let statusBox = new St.BoxLayout({ style_class: 'sync-status-box' });
        statusBox.add_child(this._statusIcon);
        statusBox.add_child(this._statusLabel);
        this._statusItem.add_child(statusBox);
        this.menu.addMenuItem(this._statusItem);

        // ── Separator ──
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── History section (scrollable) ──
        this.historySection = new PopupMenu.PopupMenuSection();
        this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
        this.historyScrollView = new St.ScrollView({
            style_class: 'ci-history-menu-section',
            overlay_scrollbars: true
        });
        this.historyScrollView.add_child(this.historySection.actor);
        this.scrollViewMenuSection.actor.add_child(this.historyScrollView);
        this.menu.addMenuItem(this.scrollViewMenuSection);

        // ── Empty state ──
        this.emptyStateSection = new St.BoxLayout({
            style_class: 'clipboard-indicator-empty-state',
            vertical: true
        });
        this.emptyStateSection.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
            x_align: Clutter.ActorAlign.CENTER
        }));
        this._emptyLabel = new St.Label({
            text: tr('clipboard-empty'),
            x_align: Clutter.ActorAlign.CENTER
        });
        this.emptyStateSection.add_child(this._emptyLabel);

        // ── Bottom separator ──
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Clear history button with timer ──
        this.clearMenuItem = new PopupMenu.PopupMenuItem(tr('clear-history'));
        this.clearMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }), 0
        );
        this.timerLabel = new St.Label({
            text: '',
            style: 'font-family: monospace;',
            x_align: Clutter.ActorAlign.END,
            x_expand: true
        });
        this.clearMenuItem.add_child(this.timerLabel);
        this.clearMenuItem.connect('activate', () => this._clearHistory());
        this.menu.addMenuItem(this.clearMenuItem);

        // ── Settings button ──
        this.settingsMenuItem = new PopupMenu.PopupMenuItem(tr('settings'));
        this.settingsMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }), 0
        );
        this.settingsMenuItem.connect('activate', () => this.extension.openSettings());
        this.menu.addMenuItem(this.settingsMenuItem);

        // ── Populate cached entries ──
        clipHistory.forEach(entry => this._addEntry(entry));
        if (clipHistory.length > 0) {
            this._selectMenuItem(this.clipItemsRadioGroup[clipHistory.length - 1]);
        }

        // Timer display: only tick when menu is visible (saves CPU/battery)
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen && AUTO_CLEAR_HOURS > 0 && NEXT_CLEAR_TIME > 0) {
                this._updateTimer();
                if (!this._timerIntervalId)
                    this._timerIntervalId = setInterval(() => this._updateTimer(), 1000);
            } else if (this._timerIntervalId) {
                clearInterval(this._timerIntervalId);
                this._timerIntervalId = null;
            }
        });

        this._updateEmptyState();
        this._menuReady = true;
    }

    _updateEmptyState () {
        const hasItems = this.clipItemsRadioGroup.length > 0;

        if (hasItems) {
            if (this.menu.box.contains(this.emptyStateSection))
                this.menu.box.remove_child(this.emptyStateSection);
            this.historyScrollView.visible = true;
            this.clearMenuItem.visible = true;
        } else {
            this.historyScrollView.visible = false;
            this.clearMenuItem.visible = false;
            if (!this.menu.box.contains(this.emptyStateSection))
                this.menu.box.insert_child_above(this.emptyStateSection, this.scrollViewMenuSection.actor);
        }
    }

    // ──────────────────────── Sync ────────────────────────

    _initSync () {
        this.sync = new MountLinkSync({
            enabled: SYNC_ENABLED,
            onClipboardReceived: (mimetype, bytes) => this._onRemoteClipboard(mimetype, bytes),
            onStateChanged: (state) => this._updateSyncStatus(state)
        });
    }

    _updateSyncStatus (state) {
        if (!this._statusLabel) return;
        this.logger.info('Sync state:', state);

        const map = {
            'connected':    { text: tr('sync-connected'),    icon: 'network-transmit-receive-symbolic', css: 'sync-connected' },
            'listening':    { text: tr('sync-listening'),    icon: 'network-receive-symbolic',          css: 'sync-connecting' },
            'connecting':   { text: tr('sync-connecting'),   icon: 'network-idle-symbolic',             css: 'sync-connecting' },
            'disconnected': { text: tr('sync-disconnected'), icon: 'network-offline-symbolic',          css: 'sync-disconnected' },
            'disabled':     { text: tr('sync-disabled'),     icon: 'network-offline-symbolic',          css: 'sync-disabled' }
        };

        const s = map[state] || map['disconnected'];
        this._statusLabel.set_text(s.text);
        this._statusIcon.icon_name = s.icon;

        for (const cls of ['sync-connected', 'sync-connecting', 'sync-disconnected', 'sync-disabled'])
            this._statusLabel.remove_style_class_name(cls);
        this._statusLabel.add_style_class_name(s.css);
    }

    _onRemoteClipboard (mimetype, bytes) {
        if (!this._menuReady || this._destroyed) return;
        const entry = new ClipboardEntry(mimetype, bytes);
        this.#lastReceivedHash = entry.getStringValue();
        this.logger.info('Remote clipboard received:',
            mimetype, `(${bytes.length} bytes)`);

        // Write to system clipboard
        this.extension.clipboard.set_content(CLIPBOARD_TYPE, mimetype, entry.asBytes());

        // Check for duplicate in history
        for (let item of this.clipItemsRadioGroup) {
            if (item.entry.equals(entry)) {
                this._selectMenuItem(item, false);
                this._clearRemoteHash();
                return;
            }
        }

        // New entry from remote
        this._addEntry(entry, true, false);
        this._removeOldestEntries();
        this._updateCache();
        this._clearRemoteHash();
    }

    _clearRemoteHash () {
        if (this._remoteHashTimeout) clearTimeout(this._remoteHashTimeout);
        this._remoteHashTimeout = setTimeout(() => {
            this.#lastReceivedHash = null;
        }, 3000);
    }

    // ──────────────────────── Entry Management ────────────────────────

    _addEntry (entry, autoSelect = false, autoSetClip = false) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.entry = entry;

        menuItem.connect('activate', () => {
            this._selectMenuItem(menuItem);
            if (PASTE_ON_SELECT) this.#pasteItem(menuItem);
        });

        menuItem.connect('key-focus-in', () => {
            AnimationUtils.ensureActorVisibleInScrollView(this.historyScrollView, menuItem);
        });

        menuItem.actor.connect('key-press-event', (actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Delete) {
                this.#focusNeighbor(menuItem);
                this._removeEntry(menuItem);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_v) {
                this.#pasteItem(menuItem);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_Return) {
                this._selectMenuItem(menuItem);
                if (PASTE_ON_SELECT) this.#pasteItem(menuItem);
                this.menu.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._setEntryLabel(menuItem);

        // Delete button
        let deleteBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'system-status-icon'
            }),
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true
        });
        deleteBtn.connect('clicked', () => this._removeEntry(menuItem));
        menuItem.actor.add_child(deleteBtn);

        this.clipItemsRadioGroup.push(menuItem);
        this.historySection.addMenuItem(menuItem, 0);

        if (autoSelect) {
            this._selectMenuItem(menuItem, autoSetClip);
        } else {
            menuItem.setOrnament(PopupMenu.Ornament.NONE);
        }

        this._updateEmptyState();
    }

    _setEntryLabel (menuItem) {
        const { entry } = menuItem;

        if (entry.isText()) {
            let text = entry.getStringValue().replace(/\s+/g, ' ');
            const chars = [...text];
            if (chars.length > MAX_ENTRY_LENGTH)
                text = chars.slice(0, MAX_ENTRY_LENGTH - 1).join('') + '...';
            menuItem.label.set_text(text);
        } else if (entry.isImage()) {
            menuItem.label.set_text(`[${tr('image')}]`);
            this.registry.getEntryAsImage(entry).then(img => {
                if (!img) return;
                img.add_style_class_name('clipboard-menu-img-preview');
                if (menuItem.previewImage)
                    menuItem.remove_child(menuItem.previewImage);
                menuItem.previewImage = img;
                menuItem.insert_child_below(img, menuItem.label);
            });
        }
    }

    _selectMenuItem (menuItem, autoSet = true) {
        for (let item of this.clipItemsRadioGroup) {
            if (item === menuItem) {
                item.setOrnament(PopupMenu.Ornament.DOT);
                item.currentlySelected = true;
                if (autoSet) {
                    this.extension.clipboard.set_content(
                        CLIPBOARD_TYPE, item.entry.mimetype(), item.entry.asBytes()
                    );
                }
            } else {
                item.setOrnament(PopupMenu.Ornament.NONE);
                item.currentlySelected = false;
            }
        }
    }

    _removeEntry (menuItem) {
        let idx = this.clipItemsRadioGroup.indexOf(menuItem);
        if (idx < 0) return;

        if (menuItem.currentlySelected)
            this.extension.clipboard.set_text(CLIPBOARD_TYPE, '');

        menuItem.destroy();
        this.clipItemsRadioGroup.splice(idx, 1);

        if (menuItem.entry.isImage())
            this.registry.deleteEntryFile(menuItem.entry);

        this._updateCache();
        this._updateEmptyState();
    }

    _removeOldestEntries () {
        let removed = false;
        while (this.clipItemsRadioGroup.length > MAX_REGISTRY_LENGTH) {
            const item = this.clipItemsRadioGroup[0];
            if (item.currentlySelected)
                this.extension.clipboard.set_text(CLIPBOARD_TYPE, '');
            item.destroy();
            this.clipItemsRadioGroup.splice(0, 1);
            if (item.entry.isImage())
                this.registry.deleteEntryFile(item.entry);
            removed = true;
        }
        if (removed) {
            // Note: caller is responsible for _updateCache()
            this._updateEmptyState();
        }
    }

    _clearHistory () {
        for (const item of this.clipItemsRadioGroup) {
            if (item.currentlySelected)
                this.extension.clipboard.set_text(CLIPBOARD_TYPE, '');
            if (item.entry.isImage())
                this.registry.deleteEntryFile(item.entry);
            item.destroy();
        }
        this.clipItemsRadioGroup.length = 0;
        this._updateCache();
        this._updateEmptyState();
    }

    _updateCache () {
        if (this._cacheWriteTimeout) clearTimeout(this._cacheWriteTimeout);
        this._cacheWriteTimeout = setTimeout(() => this._flushCache(), 300);
    }

    _flushCache () {
        if (this._cacheWriteTimeout) { clearTimeout(this._cacheWriteTimeout); this._cacheWriteTimeout = null; }
        if (this._destroyed) return;
        const entries = this.clipItemsRadioGroup.map(item => item.entry);
        this.registry.write(entries);
    }

    #focusNeighbor (menuItem) {
        let idx = this.clipItemsRadioGroup.indexOf(menuItem);
        let next = this.clipItemsRadioGroup[idx - 1] || this.clipItemsRadioGroup[idx + 1];
        if (next) next.actor.grab_key_focus();
    }

    // ──────────────────────── Clipboard Listener ────────────────────────

    _setupListener () {
        const display = Shell.Global.get().get_display();
        this.selection = display.get_selection();
        this._selectionOwnerChangedId = this.selection.connect('owner-changed',
            (sel, type, _source) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._refreshIndicator();
            }
        );
    }

    async _refreshIndicator () {
        if (!this._menuReady || this.#refreshInProgress || this._destroyed) return;
        this.#refreshInProgress = true;

        try {
            const entry = await this.#getClipboardContent();
            if (!entry) return;

            // Content-based loop prevention
            const isFromRemote = this.#lastReceivedHash !== null &&
                                 entry.getStringValue() === this.#lastReceivedHash;

            // Deduplicate: if already in history, just select it
            for (let item of this.clipItemsRadioGroup) {
                if (item.entry.equals(entry)) {
                    this._selectMenuItem(item, false);
                    if (!isFromRemote) this.sync?.send(entry.mimetype(), entry.rawBytes());
                    return;
                }
            }

            // New local clipboard entry
            this._addEntry(entry, true, false);
            this._removeOldestEntries();
            this._updateCache();

            this.logger.info('New clipboard entry:',
                entry.isText() ? `text(${entry.getStringValue().length} chars)` : entry.mimetype());
            if (!isFromRemote) this.sync?.send(entry.mimetype(), entry.rawBytes());
        } catch (e) {
            console.error('Clipboard Indicator: refresh error', e);
            this.logger.error('Refresh error', e);
        } finally {
            this.#refreshInProgress = false;
        }
    }

    async #getClipboardContent () {
        const mimetypes = [
            'text/plain;charset=utf-8',
            'UTF8_STRING',
            'text/plain',
            'STRING',
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
        ];

        for (let type of mimetypes) {
            let result = await new Promise(resolve => {
                this.extension.clipboard.get_content(CLIPBOARD_TYPE, type, (cb, bytes) => {
                    if (!bytes || bytes.get_size() === 0) { resolve(null); return; }

                    // Workaround: GNOME mangles mimetype on 2nd+ copy
                    if (type === 'UTF8_STRING') type = 'text/plain;charset=utf-8';

                    resolve(new ClipboardEntry(type, bytes.get_data()));
                });
            });
            if (result) return result;
        }
        return null;
    }

    // ──────────────────────── Auto-Clear Timer ────────────────────────

    _setupAutoClear () {
        this._fetchSettings();

        // Clean up old listeners
        if (this._autoClearSettingId) {
            this.extension.settings.disconnect(this._autoClearSettingId);
            this._autoClearSettingId = null;
        }
        this._autoClearSettingId = this.extension.settings.connect(
            `changed::${PrefsFields.AUTO_CLEAR_HOURS}`,
            () => this._setupAutoClear()
        );

        if (this._clearTimeoutId) { clearTimeout(this._clearTimeoutId); this._clearTimeoutId = null; }
        if (this._timerIntervalId) { clearInterval(this._timerIntervalId); this._timerIntervalId = null; }

        if (AUTO_CLEAR_HOURS <= 0) {
            if (this.timerLabel) this.timerLabel.visible = false;
            this.extension.settings.set_int(PrefsFields.NEXT_CLEAR_TIME, -1);
            return;
        }

        if (this.timerLabel) this.timerLabel.visible = true;
        const now = Math.ceil(Date.now() / 1000);

        if (NEXT_CLEAR_TIME > 0 && NEXT_CLEAR_TIME < now) {
            // Timer expired while extension was off
            this._clearHistory();
            NEXT_CLEAR_TIME = now + AUTO_CLEAR_HOURS * 3600;
        } else if (NEXT_CLEAR_TIME <= 0) {
            // No timer set yet
            NEXT_CLEAR_TIME = now + AUTO_CLEAR_HOURS * 3600;
        }
        // else: existing timer still valid

        this.extension.settings.set_int(PrefsFields.NEXT_CLEAR_TIME, NEXT_CLEAR_TIME);

        const remainMs = Math.max(0, (NEXT_CLEAR_TIME - now) * 1000);
        this._clearTimeoutId = setTimeout(() => {
            this._clearHistory();
            this._scheduleNextClear();
        }, remainMs);

        this._updateTimer();
    }

    _scheduleNextClear () {
        if (this._clearTimeoutId) clearTimeout(this._clearTimeoutId);
        if (this._timerIntervalId) clearInterval(this._timerIntervalId);

        if (AUTO_CLEAR_HOURS <= 0) {
            if (this.timerLabel) this.timerLabel.visible = false;
            return;
        }

        const now = Math.ceil(Date.now() / 1000);
        NEXT_CLEAR_TIME = now + AUTO_CLEAR_HOURS * 3600;
        this.extension.settings.set_int(PrefsFields.NEXT_CLEAR_TIME, NEXT_CLEAR_TIME);

        this._clearTimeoutId = setTimeout(() => {
            this._clearHistory();
            this._scheduleNextClear();
        }, AUTO_CLEAR_HOURS * 3600 * 1000);

        this._updateTimer();
    }

    _updateTimer () {
        if (!this.timerLabel) return;
        if (AUTO_CLEAR_HOURS <= 0 || NEXT_CLEAR_TIME <= 0) {
            this.timerLabel.set_text('');
            return;
        }

        let timeLeft = NEXT_CLEAR_TIME - Math.ceil(Date.now() / 1000);
        if (timeLeft <= 0) { this.timerLabel.set_text(''); return; }

        const h = Math.floor(timeLeft / 3600);
        const m = Math.floor((timeLeft % 3600) / 60);
        const s = timeLeft % 60;

        let text = '';
        if (h > 0) text += `${h}h `;
        if (m > 0 || h > 0) text += `${m}m `;
        text += `${s}s`;
        this.timerLabel.set_text(text);
    }

    // ──────────────────────── Paste ────────────────────────

    #pasteItem (menuItem) {
        this.menu.close();
        const selected = this.clipItemsRadioGroup.find(i => i.currentlySelected);

        // Set clipboard to the item to paste
        this.extension.clipboard.set_content(
            CLIPBOARD_TYPE, menuItem.entry.mimetype(), menuItem.entry.asBytes()
        );

        this._pasteKeypressTimeout = setTimeout(() => {
            if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
                this.keyboard.release(Clutter.KEY_Control_L);
            } else {
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
            }

            // Restore previous clipboard selection
            this._pasteResetTimeout = setTimeout(() => {
                if (selected && selected.entry) {
                    this.extension.clipboard.set_content(
                        CLIPBOARD_TYPE, selected.entry.mimetype(), selected.entry.asBytes()
                    );
                }
            }, 50);
        }, 50);
    }

    // ──────────────────────── Settings ────────────────────────

    _loadSettings () {
        this._settingsChangedId = this.extension.settings.connect('changed',
            () => this._onSettingsChange()
        );
        this._fetchSettings();
        if (ENABLE_KEYBINDING) this._bindShortcuts();
    }

    _fetchSettings () {
        const s = this.extension.settings;
        MAX_REGISTRY_LENGTH = s.get_int(PrefsFields.HISTORY_SIZE);
        MAX_ENTRY_LENGTH    = s.get_int(PrefsFields.PREVIEW_SIZE);
        MAX_CACHE_SIZE      = s.get_int(PrefsFields.CACHE_FILE_SIZE);
        PASTE_ON_SELECT     = s.get_boolean(PrefsFields.PASTE_ON_SELECT);
        ENABLE_KEYBINDING   = s.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        AUTO_CLEAR_HOURS    = s.get_int(PrefsFields.AUTO_CLEAR_HOURS);
        NEXT_CLEAR_TIME     = s.get_int(PrefsFields.NEXT_CLEAR_TIME);
        SYNC_ENABLED        = s.get_boolean(PrefsFields.SYNC_ENABLED);
        ENABLE_LOGGING      = s.get_boolean(PrefsFields.ENABLE_LOGGING);

        setLanguage(s.get_string(PrefsFields.LANGUAGE));
    }

    _onSettingsChange () {
        this._fetchSettings();
        this._removeOldestEntries();
        this._updateCache();

        // Refresh entry labels in case preview size changed
        this.clipItemsRadioGroup.forEach(item => this._setEntryLabel(item));

        // Update sync module
        this.sync?.updateSettings({ enabled: SYNC_ENABLED });
        this._updateSyncStatus(this.sync?.state);

        // Update logger
        this.logger.setEnabled(ENABLE_LOGGING);

        // Shortcuts
        if (ENABLE_KEYBINDING) this._bindShortcuts();
        else this._unbindShortcuts();

        // Update translatable labels
        this._updateLabels();
    }

    _updateLabels () {
        this.clearMenuItem?.label?.set_text(tr('clear-history'));
        this.settingsMenuItem?.label?.set_text(tr('settings'));
        if (this._emptyLabel) this._emptyLabel.set_text(tr('clipboard-empty'));
        this._updateSyncStatus(this.sync?.state);
    }

    // ──────────────────────── Shortcuts ────────────────────────

    _bindShortcuts () {
        this._unbindShortcuts();
        var ModeType = Shell.hasOwnProperty('ActionMode') ?
            Shell.ActionMode : Shell.KeyBindingMode;

        Main.wm.addKeybinding(
            PrefsFields.BINDING_TOGGLE_MENU,
            this.extension.settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            () => this.menu.toggle()
        );
        this._shortcutsBindingIds.push(PrefsFields.BINDING_TOGGLE_MENU);
    }

    _unbindShortcuts () {
        this._shortcutsBindingIds.forEach(id => Main.wm.removeKeybinding(id));
        this._shortcutsBindingIds = [];
    }

    // ──────────────────────── Cleanup ────────────────────────

    _disconnectSettings () {
        if (this._settingsChangedId) {
            this.extension.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._autoClearSettingId) {
            this.extension.settings.disconnect(this._autoClearSettingId);
            this._autoClearSettingId = null;
        }
    }

    _disconnectSelectionListener () {
        if (this._selectionOwnerChangedId && this.selection) {
            this.selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = null;
        }
    }

    #clearTimeouts () {
        if (this._cacheWriteTimeout) { clearTimeout(this._cacheWriteTimeout); this._cacheWriteTimeout = null; }
        if (this._clearTimeoutId) clearTimeout(this._clearTimeoutId);
        if (this._timerIntervalId) clearInterval(this._timerIntervalId);
        if (this._pasteKeypressTimeout) clearTimeout(this._pasteKeypressTimeout);
        if (this._pasteResetTimeout) clearTimeout(this._pasteResetTimeout);
        if (this._remoteHashTimeout) clearTimeout(this._remoteHashTimeout);
    }
});
