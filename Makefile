UUID = clipboard-indicator@tudmotu.com
DIST_FILES = extension.js prefs.js registry.js sync.js keyboard.js constants.js locale.js stylesheet.css metadata.json
SCHEMA_DIR = schemas

.PHONY: all build install uninstall clean

all: build

build:
	glib-compile-schemas --strict --targetdir=$(SCHEMA_DIR) $(SCHEMA_DIR)
	mkdir -p dist
	cd . && zip -j dist/$(UUID).shell-extension.zip $(DIST_FILES) && cd $(SCHEMA_DIR) && zip ../dist/$(UUID).shell-extension.zip gschemas.compiled *.xml

install: build
	gnome-extensions install --force dist/$(UUID).shell-extension.zip

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -rf dist
	rm -f $(SCHEMA_DIR)/gschemas.compiled
