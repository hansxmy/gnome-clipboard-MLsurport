import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

export class Registry {
    constructor (uuid) {
        this.uuid = uuid;
        this.REGISTRY_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), uuid]);
        this.REGISTRY_PATH = GLib.build_filenamev([this.REGISTRY_DIR, 'registry.txt']);
    }

    write (entries) {
        const data = entries.map(entry => {
            const item = { mimetype: entry.mimetype() };
            if (entry.isText()) {
                item.contents = entry.getStringValue();
            } else if (entry.isImage()) {
                item.contents = this.getEntryFilename(entry);
                this.writeEntryFile(entry).catch(e =>
                    console.error('Failed to write entry file:', e));
            }
            return item;
        });

        GLib.mkdir_with_parents(this.REGISTRY_DIR, 0o775);
        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        const bytes = new GLib.Bytes(JSON.stringify(data));

        file.replace_async(null, false, Gio.FileCreateFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                try {
                    let stream = obj.replace_finish(res);
                    stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null, (w, r) => {
                        try {
                            w.write_bytes_finish(r);
                        } catch (e) { console.error(e); }
                        finally { try { stream.close(null); } catch (_) {} }
                    });
                } catch (e) { console.error(e); }
            });
    }

    async read (maxSize, maxCacheMB = 10) {
        if (!GLib.file_test(this.REGISTRY_PATH, GLib.FileTest.EXISTS))
            return [];

        // Guard: if cache file exceeds max size, reset
        try {
            const file = Gio.file_new_for_path(this.REGISTRY_PATH);
            const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_size() > maxCacheMB * 1024 * 1024) {
                console.warn('Clipboard Indicator: cache file too large, resetting');
                this.clearCacheFolder();
                return [];
            }
        } catch (e) { /* proceed anyway */ }

        return new Promise(resolve => {
            const file = Gio.file_new_for_path(this.REGISTRY_PATH);

            file.load_contents_async(null, (obj, res) => {
                try {
                    let [success, contents] = obj.load_contents_finish(res);
                    if (!success) { resolve([]); return; }

                    const registry = JSON.parse(new TextDecoder().decode(contents));
                    const promises = registry.map(json => ClipboardEntry.fromJSON(json));

                    Promise.all(promises).then(entries => {
                        entries = entries.filter(e => e !== null);
                        // Keep only the newest maxSize entries
                        while (maxSize && entries.length > maxSize) {
                            entries.shift();
                        }
                        resolve(entries);
                    }).catch(e => {
                        console.error('Clipboard Indicator: registry read error', e);
                        resolve([]);
                    });
                } catch (e) {
                    console.error('Clipboard Indicator: registry parse error', e);
                    resolve([]);
                }
            });
        });
    }

    getEntryFilename (entry) {
        // Use unsigned hash to avoid negative numbers in filenames
        const h = entry.asBytes().hash() >>> 0;
        return GLib.build_filenamev([this.REGISTRY_DIR, String(h)]);
    }

    async getEntryAsImage (entry) {
        if (!entry.isImage()) return null;
        const filename = this.getEntryFilename(entry);

        if (!GLib.file_test(filename, GLib.FileTest.EXISTS)) {
            await this.writeEntryFile(entry);
        }

        return new St.Icon({ gicon: Gio.icon_new_for_string(filename) });
    }

    async writeEntryFile (entry) {
        const filename = this.getEntryFilename(entry);
        if (GLib.file_test(filename, GLib.FileTest.EXISTS)) return;

        const file = Gio.file_new_for_path(filename);
        return new Promise((resolve, reject) => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        let stream = obj.replace_finish(res);
                        stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT, null, (w, r) => {
                            try {
                                w.write_bytes_finish(r);
                                resolve();
                            } catch (e) { reject(e); }
                            finally { try { stream.close(null); } catch (_) {} }
                        });
                    } catch (e) { reject(e); }
                });
        });
    }

    deleteEntryFile (entry) {
        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try { obj.delete_finish(res); } catch (e) { /* ignore: file may not exist */ }
        });
    }

    clearCacheFolder () {
        try {
            const folder = Gio.file_new_for_path(this.REGISTRY_DIR);
            const enumerator = folder.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = enumerator.next_file(null)) != null) {
                const child = folder.get_child(info.get_name());
                try { child.delete(null); } catch (e) { /* best-effort */ }
            }
        } catch (e) {
            console.error('Clipboard Indicator: clear cache error', e);
        }
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #glibBytes = null;
    #cachedString = null;

    static __isText (mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    static async fromJSON (json) {
        const mimetype = json.mimetype || 'text/plain;charset=utf-8';
        let bytes;

        if (ClipboardEntry.__isText(mimetype)) {
            bytes = new TextEncoder().encode(json.contents);
        } else {
            // Image: contents is the file path
            const filename = json.contents;
            if (!GLib.file_test(filename, GLib.FileTest.EXISTS)) return null;

            const file = Gio.file_new_for_path(filename);
            bytes = await new Promise((resolve, reject) => {
                file.load_contents_async(null, (obj, res) => {
                    try {
                        let [success, data] = obj.load_contents_finish(res);
                        success ? resolve(data) : reject(new Error('Failed to read cached image'));
                    } catch (e) { reject(e); }
                });
            });
        }

        return new ClipboardEntry(mimetype, bytes);
    }

    constructor (mimetype, bytes) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
    }

    getStringValue () {
        if (this.#cachedString !== null) return this.#cachedString;
        this.#cachedString = this.isImage()
            ? `[Image ${this.asBytes().hash()}]`
            : new TextDecoder().decode(this.#bytes);
        return this.#cachedString;
    }

    mimetype ()  { return this.#mimetype; }
    isText ()    { return ClipboardEntry.__isText(this.#mimetype); }
    isImage ()   { return this.#mimetype.startsWith('image/'); }
    asBytes ()   { return this.#glibBytes ??= GLib.Bytes.new(this.#bytes); }
    rawBytes ()  { return this.#bytes; }

    equals (other) {
        if (this.isImage() && other.isImage()) {
            // Compare both hash and byte length to reduce collision risk
            return this.asBytes().hash() === other.asBytes().hash() &&
                   this.asBytes().get_size() === other.asBytes().get_size();
        }
        return this.getStringValue() === other.getStringValue();
    }
}
