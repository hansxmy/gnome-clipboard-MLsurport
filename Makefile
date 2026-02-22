UUID = clipboard-indicator@tudmotu.com
DIST_FILES = extension.js prefs.js registry.js sync.js keyboard.js constants.js locale.js logger.js stylesheet.css metadata.json
SCHEMA_DIR = schemas
LOCALE_DIR = locale

.PHONY: all build install uninstall clean

all: build

build:
	glib-compile-schemas --strict --targetdir=$(SCHEMA_DIR) $(SCHEMA_DIR)
	mkdir -p dist
	zip -j dist/$(UUID).shell-extension.zip $(DIST_FILES)
	zip -r dist/$(UUID).shell-extension.zip $(SCHEMA_DIR)/gschemas.compiled $(SCHEMA_DIR)/*.xml
	zip -r dist/$(UUID).shell-extension.zip $(LOCALE_DIR)/

install: build
	gnome-extensions install --force dist/$(UUID).shell-extension.zip

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -rf dist
	rm -f $(SCHEMA_DIR)/gschemas.compiled
