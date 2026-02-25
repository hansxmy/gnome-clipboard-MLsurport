/**
 * MountLink Clipboard Sync — D-Bus Module
 *
 * Communicates with MountLink via the D-Bus session bus instead of TCP.
 * This eliminates local port usage, avoids port conflicts, and is more
 * lightweight on the GNOME main loop.
 *
 * D-Bus contract (owned by MountLink Dart process):
 *   Bus name:   com.mountlink.ClipboardSync
 *   Object:     /com/mountlink/ClipboardSync
 *   Interface:  com.mountlink.ClipboardSync
 *
 *   Method:  SendClipboard(mimetype: s, data: s)        ← extension calls
 *   Signal:  ClipboardReceived(mimetype: s, data: s)    ← ML emits
 *   Property: State (s)
 *   Property: ErrorDetail (s)  — human-readable reason for error/stopped state
 *
 * All "data" values are base64-encoded raw bytes.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'com.mountlink.ClipboardSync';
const OBJ_PATH = '/com/mountlink/ClipboardSync';
const IFACE    = 'com.mountlink.ClipboardSync';
const ACTIVE_SEND_STATES = new Set(['connected', 'listening']);

const MAX_SYNC_SIZE = 14 * 1024 * 1024; // ~10 MB decoded (base64 overhead)

const INTROSPECT_XML = `
<node>
  <interface name="${IFACE}">
    <method name="SendClipboard">
      <arg name="mimetype" type="s" direction="in"/>
      <arg name="data"     type="s" direction="in"/>
    </method>
    <signal name="ClipboardReceived">
      <arg name="mimetype" type="s"/>
      <arg name="data"     type="s"/>
    </signal>
    <property name="State" type="s" access="read"/>
    <property name="ErrorDetail" type="s" access="read"/>
  </interface>
</node>`;

let _nodeInfo, _ifaceInfo;
try {
    _nodeInfo  = Gio.DBusNodeInfo.new_for_xml(INTROSPECT_XML);
    _ifaceInfo = _nodeInfo.lookup_interface(IFACE);
} catch (e) {
    console.error('MountLinkSync: failed to parse introspect XML:', e);
}

export class MountLinkSync {
    #proxy = null;
    #enabled;
    #state = 'disconnected';
    #errorDetail = '';
    #onClipboardReceived = null;
    #onStateChanged = null;
    #destroyed = false;

    #nameWatcherId = 0;
    #signalSubId = 0;
    #propChangedId = 0;
    #busConnection = null;

    constructor ({ enabled, onClipboardReceived, onStateChanged }) {
        this.#enabled = enabled;
        this.#onClipboardReceived = onClipboardReceived;
        this.#onStateChanged = onStateChanged;

        if (enabled) this.#watchBus();
        else this.#setState('disabled');
    }

    get state () { return this.#state; }
    get errorDetail () { return this.#errorDetail; }

    updateSettings ({ enabled }) {
        if (enabled === this.#enabled) return;
        this.#enabled = enabled;

        if (!enabled) {
            this.#unwatchBus();
            this.#setState('disabled');
            return;
        }

        this.#watchBus();
    }

    /**
     * Send clipboard content to MountLink over D-Bus.
     * @param {string} mimetype
     * @param {Uint8Array} bytes
     */
    send (mimetype, bytes) {
        if (!this.#proxy || !this.#enabled) return;
        if (!ACTIVE_SEND_STATES.has(this.#state)) return;
        if (!bytes || !mimetype) return;

        try {
            const data = GLib.base64_encode(bytes);
            if (data.length > MAX_SYNC_SIZE) return;
            this.#proxy.call(
                'SendClipboard',
                new GLib.Variant('(ss)', [mimetype, data]),
                Gio.DBusCallFlags.NONE,
                5000, null,
                (_proxy, res) => {
                    try { _proxy.call_finish(res); }
                    catch (e) { console.debug('MountLink: D-Bus async error', e); }
                }
            );
        } catch (e) {
            console.error('MountLink sync: D-Bus send failed', e);
        }
    }

    destroy () {
        this.#destroyed = true;
        this.#unwatchBus();
    }

    // ── Private ──

    #setState (state) {
        if (this.#state === state) return;
        this.#state = state;
        this.#onStateChanged?.(state);
    }

    #watchBus () {
        if (this.#nameWatcherId || this.#destroyed || !this.#enabled) return;
        this.#setState('connecting');

        this.#nameWatcherId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            (_conn, _name, _owner) => this.#onNameAppeared(_conn),
            (_conn, _name) => this.#onNameVanished()
        );
    }

    #unwatchBus () {
        this.#unsubSignals();
        if (this.#nameWatcherId) {
            Gio.bus_unwatch_name(this.#nameWatcherId);
            this.#nameWatcherId = 0;
        }
        this.#busConnection = null;
        this.#proxy = null;
    }

    #unsubSignals () {
        if (this.#signalSubId) {
            try {
                this.#busConnection?.signal_unsubscribe(this.#signalSubId);
            } catch (e) { console.debug('MountLink: signal unsub:', e.message); }
            this.#signalSubId = 0;
        }
        if (this.#propChangedId && this.#proxy) {
            this.#proxy.disconnect(this.#propChangedId);
            this.#propChangedId = 0;
        }
    }

    #onNameAppeared (connection) {
        if (this.#destroyed) return;
        if (!_ifaceInfo) {
            console.error('MountLinkSync: introspect info unavailable, cannot create proxy');
            return;
        }
        this.#unsubSignals();
        this.#busConnection = connection;

        // Async proxy creation — avoids blocking GNOME Shell main loop
        Gio.DBusProxy.new(
            connection,
            Gio.DBusProxyFlags.NONE,
            _ifaceInfo,
            BUS_NAME,
            OBJ_PATH,
            IFACE,
            null,
            (_obj, res) => {
                if (this.#destroyed || !this.#enabled) return;
                try {
                    this.#proxy = Gio.DBusProxy.new_finish(res);
                } catch (e) {
                    console.error('MountLink sync: proxy creation failed', e);
                    this.#setState('disconnected');
                    return;
                }
                if (this.#destroyed || !this.#enabled) { this.#proxy = null; return; }

                // Subscribe to ClipboardReceived signal
                this.#signalSubId = connection.signal_subscribe(
                    BUS_NAME, IFACE, 'ClipboardReceived', OBJ_PATH,
                    null, Gio.DBusSignalFlags.NONE,
                    (_c, _s, _p, _i, _sig, params) => this.#onSignal(params)
                );

                // Watch for State and ErrorDetail property changes
                this.#propChangedId = this.#proxy.connect(
                    'g-properties-changed', (_proxy, changed, _inv) => {
                        const v = changed.lookup_value('State', null);
                        if (v) this.#setState(v.get_string()[0] || 'connected');
                        const d = changed.lookup_value('ErrorDetail', null);
                        if (d) this.#errorDetail = d.get_string()[0] || '';
                    }
                );

                // Read initial State from the proxy's property cache
                const cachedState = this.#proxy.get_cached_property('State');
                const initialState = cachedState ? (cachedState.get_string()[0] || 'connected') : 'connecting';
                this.#setState(initialState);
            }
        );
    }

    #onNameVanished () {
        if (this.#destroyed) return;
        this.#unsubSignals();
        this.#busConnection = null;
        this.#proxy = null;
        if (this.#enabled) this.#setState('disconnected');
    }

    #onSignal (params) {
        if (this.#destroyed) return;
        try {
            const mimetype = params.get_child_value(0).get_string()[0];
            const b64data  = params.get_child_value(1).get_string()[0];
            if (b64data.length > MAX_SYNC_SIZE) return;
            const bytes = GLib.base64_decode(b64data);
            this.#onClipboardReceived?.(mimetype, bytes);
        } catch (e) {
            console.error('MountLink sync: signal parse error', e);
        }
    }
}
