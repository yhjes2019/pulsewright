/*
 * Pulsewright for Zotero — bootstrap entry.
 *
 * Zotero calls the top-level functions below (startup / shutdown /
 * onMainWindowLoad / onMainWindowUnload) inside the plugin sandbox, so they
 * must be declared at file scope rather than hung off an object. All shared
 * state lives on `PW` to keep a single instance alive across windows.
 */
var PW = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  windows: new Set(),

  log: function (msg) {
    try {
      Zotero.debug('[Pulsewright] ' + msg);
    } catch (e) {
      /* ignore */
    }
  },

  loadScripts: function () {
    var self = this;
    var list = ['content/scripts/core.js', 'content/scripts/sixpane.js'];
    for (var i = 0; i < list.length; i++) {
      var uri = self.rootURI + list[i];
      self.log('loading ' + uri);
      Services.scriptloader.loadSubScript(uri, globalThis, 'UTF-8');
    }
    if (typeof PWCore !== 'object' || !PWCore || !PWCore.tokenize) {
      throw new Error('core.js did not export PWCore');
    }
    if (typeof PulsewrightSix !== 'object' || !PulsewrightSix) {
      throw new Error('sixpane.js did not export PulsewrightSix');
    }
  },

  // Zotero registers the plugin's FTL into a shared l10n source but never
  // links it into a window, so section headers would render with no label.
  // The resource id is the file name inside locale/<locale>/.
  localize: function (win) {
    try {
      var d = win && win.document;
      if (d && d.l10n && d.l10n.addResourceIds) d.l10n.addResourceIds(['pulsewright.ftl']);
    } catch (e) {
      this.log('localize skipped: ' + (e && e.message));
    }
  },

  register: function () {
    try {
      PulsewrightSix.register(this.id, PWCore, { version: this.version, rootURI: this.rootURI });
      this.log('section registered');

    } catch (e) {
      Zotero.logError(e);
      this.log('section registration failed: ' + (e && e.message));
    }
  }
};

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
  PW.id = id;
  PW.version = version;
  PW.rootURI = rootURI;
  PW.log('startup v' + version + ' reason ' + reason);
  try {
    PW.loadScripts();
  } catch (e) {
    Zotero.logError(e);
    PW.log('load failed: ' + (e && e.message));
    return;
  }
  PW.register();
  PW.initialized = true;
  try { PW.localize(Zotero.getMainWindow()); } catch (e) { /* ignore */ }

  // A plugin that starts at APP_STARTUP finds the main window already open, so
  // onMainWindowLoad never fires for it: do the window-dependent work here.

}

function onMainWindowLoad({ window }) {
  if (!PW.initialized || !window) return;
  PW.windows.add(window);
  PW.localize(window);
  try { PulsewrightSix.addEntryPoints(window); } catch (e) { Zotero.logError(e); }
}

function onMainWindowUnload({ window }) {
  if (!window) return;
  PW.windows.delete(window);
}

async function shutdown(_, reason) {
  PW.log('shutdown reason ' + reason);
  try {
    if (typeof PulsewrightSix !== 'undefined' && PulsewrightSix) PulsewrightSix.unregister();
  } catch (e) {
    Zotero.logError(e);
  }
  PW.windows.clear();
  PW.initialized = false;
}
