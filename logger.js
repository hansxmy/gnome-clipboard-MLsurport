/**
 * File logger for Clipboard Indicator extension.
 *
 * Writes timestamped log lines to a rotating file in the extension's cache
 * directory.  The logger is designed to be lightweight — when disabled it is
 * essentially a no-op; when enabled it batches writes via a short debounce so
 * rapid log bursts don't cause excessive I/O on low-power devices.
 *
 * Log location:  ~/.cache/<uuid>/logs/clipboard-indicator.log
 * Rotation:      When the file exceeds MAX_LOG_SIZE the current file is
 *                renamed to .log.1 (only one backup is kept).
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MAX_LOG_SIZE = 1 * 1024 * 1024;   // 1 MB per file
const FLUSH_INTERVAL_MS = 2000;          // batch-write every 2 s

export class Logger {
    #enabled = false;
    #logDir = null;
    #logPath = null;
    #buffer = [];
    #flushTimeoutId = null;
    #destroyed = false;

    /**
     * @param {string} uuid  Extension UUID – used to derive the cache path.
     * @param {boolean} enabled  Initial state.
     */
    constructor (uuid, enabled = false) {
        this.#logDir = GLib.build_filenamev([GLib.get_user_cache_dir(), uuid, 'logs']);
        this.#logPath = GLib.build_filenamev([this.#logDir, 'clipboard-indicator.log']);
        this.#enabled = enabled;
    }

    /** Absolute path to the log directory (for "open folder" in prefs). */
    get logDir () { return this.#logDir; }

    /** Absolute path to the current log file. */
    get logPath () { return this.#logPath; }

    get enabled () { return this.#enabled; }

    setEnabled (v) {
        this.#enabled = v;
        if (!v) this.flush();           // write remaining buffer when disabling
    }

    /**
     * Append a log line.  Cheap when disabled (early return).
     * @param {'INFO'|'WARN'|'ERROR'} level
     * @param  {...any} args
     */
    log (level, ...args) {
        if (!this.#enabled || this.#destroyed) return;

        const now = new Date();
        const ts = `${now.getFullYear()}-${_p(now.getMonth() + 1)}-${_p(now.getDate())} ` +
                   `${_p(now.getHours())}:${_p(now.getMinutes())}:${_p(now.getSeconds())}.` +
                   `${String(now.getMilliseconds()).padStart(3, '0')}`;

        const msg = args.map(a => {
            if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
            if (typeof a === 'object') {
                try { return JSON.stringify(a); } catch { return String(a); }
            }
            return String(a);
        }).join(' ');

        this.#buffer.push(`[${ts}] [${level}] ${msg}\n`);

        // Schedule a batched flush
        if (!this.#flushTimeoutId) {
            this.#flushTimeoutId = setTimeout(() => {
                this.#flushTimeoutId = null;
                this.flush();
            }, FLUSH_INTERVAL_MS);
        }
    }

    info  (...args) { this.log('INFO',  ...args); }
    warn  (...args) { this.log('WARN',  ...args); }
    error (...args) { this.log('ERROR', ...args); }

    /** Immediately write buffered lines to disk. */
    flush () {
        if (this.#buffer.length === 0) return;

        try {
            GLib.mkdir_with_parents(this.#logDir, 0o755);
            this.#rotate();

            const data = this.#buffer.join('');
            this.#buffer.length = 0;

            const file = Gio.file_new_for_path(this.#logPath);
            const flags = Gio.FileCreateFlags.NONE;
            let stream;

            if (file.query_exists(null)) {
                stream = file.append_to(flags, null);
            } else {
                stream = file.create(flags, null);
            }
            stream.write_all(new TextEncoder().encode(data), null);
            stream.close(null);
        } catch (e) {
            // Last resort — dump to journal so we don't lose the info entirely
            console.error('Clipboard Indicator logger: flush error', e);
        }
    }

    /** Call on extension destroy. */
    destroy () {
        this.#destroyed = true;
        if (this.#flushTimeoutId) {
            clearTimeout(this.#flushTimeoutId);
            this.#flushTimeoutId = null;
        }
        this.flush();
    }

    // ── Private ──

    #rotate () {
        try {
            const file = Gio.file_new_for_path(this.#logPath);
            if (!file.query_exists(null)) return;
            const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_size() < MAX_LOG_SIZE) return;

            const backup = Gio.file_new_for_path(this.#logPath + '.1');
            if (backup.query_exists(null)) backup.delete(null);
            file.move(backup, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (e) {
            /* best-effort rotation */
        }
    }
}

/** Zero-pad to 2 digits. */
function _p (n) { return String(n).padStart(2, '0'); }
