'use strict';

// Runs first: nothing waits forever on the network, the app's windows only show its own pages, IPC only
// comes from those pages, Linux runs through X11, the data folder keeps its old name, and only one copy
// of the app runs.
const path = require('path');
const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const ROOT = path.join(__dirname, '..'); // src

module.exports = function (C) {
  // ---------- network: nothing waits forever ----------
  // Every request the app makes gives up after 20 seconds (unless it brings its own limit), so a server
  // that never answers can't leave a spinner up for good.
  {
    const realFetch = net.fetch.bind(net);
    net.fetch = async (url, opts = {}) => {
      if (opts.signal) return realFetch(url, opts);
      try { return await realFetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) { let host = ''; try { host = new URL(String(url)).hostname; } catch (_) { /* ignore */ } throw new Error(`${host || 'The server'} didn't answer within 20 seconds`); }
        throw err;
      }
    };
  }
  // a page step (load or script) that might never finish
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

  // ---------- window safety ----------
  // The app's own windows only ever show its own pages (src/ui), and only those pages may talk to the
  // app (IPC): a link or file dropped on a window can't turn it into a website with the app's API.
  // The pathofexile.com windows (sign-in, the hidden trade page) stay on pathofexile.com and its sign-in
  // providers, and get no browser permissions (camera, clipboard, notifications...).
  const UI_DIR = path.join(ROOT, 'ui');
  function isAppPage(url) {
    try {
      if (!/^file:/i.test(String(url))) return false;
      const f = path.normalize(require('url').fileURLToPath(String(url).split(/[?#]/)[0]));
      return f.startsWith(UI_DIR + path.sep);
    } catch (_) { return false; }
  }
  const POE_HOSTS = /(^|\.)(pathofexile\.com|steamcommunity\.com|steampowered\.com|epicgames\.com|live\.com|microsoftonline\.com|xbox\.com|playstation\.com|sony\.com|sonyentertainmentnetwork\.com|google\.com|apple\.com)$/i;
  function isPoeLoginUrl(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && POE_HOSTS.test(u.hostname); } catch (_) { return false; }
  }
  const PARTITION_POE = 'persist:poe'; // = POE_PARTITION below
  function guardContents(wc) {
    const poe = () => { try { return wc.session === require('electron').session.fromPartition(PARTITION_POE); } catch (_) { return false; } };
    wc.on('will-navigate', (e, url) => {
      if (poe() ? isPoeLoginUrl(url) : isAppPage(url)) return;
      e.preventDefault();
      // a link the player clicked in the (visible) sign-in window: their browser, not this app
      if (poe() && /^https:\/\//i.test(url)) { try { const w = BrowserWindow.fromWebContents(wc); if (w && w.isVisible()) shell.openExternal(url); } catch (_) { /* ignore */ } }
    });
    wc.on('will-redirect', (e, url) => { if (poe() ? !isPoeLoginUrl(url) && !/^https:\/\//i.test(url) : !isAppPage(url)) e.preventDefault(); });
    wc.setWindowOpenHandler(({ url }) => {
      if (poe() && isPoeLoginUrl(url)) wc.loadURL(url); // a sign-in provider opening in a new window: same window instead
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  }
  app.on('web-contents-created', (_e, wc) => guardContents(wc));
  app.whenReady().then(() => {
    const { session } = require('electron');
    for (const ses of [session.defaultSession, session.fromPartition(PARTITION_POE)]) {
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
    }
  });
  // every IPC message must come from one of the app's own pages
  for (const k of ['handle', 'handleOnce', 'on', 'once']) {
    const orig = ipcMain[k].bind(ipcMain);
    ipcMain[k] = (channel, fn) => orig(channel, (e, ...args) => {
      const url = e && e.senderFrame ? e.senderFrame.url : '';
      if (!isAppPage(url)) {
        try { C.log(`ipc ${channel}: refused, not from the app's own page`); } catch (_) { /* ignore */ }
        if (k.startsWith('handle')) throw new Error('Not allowed.');
        return undefined;
      }
      return fn(e, ...args);
    });
  }

  // Linux: run through X11 (XWayland on Wayland desktops). Global hotkeys, putting the popup at the
  // mouse and sending Ctrl+C to the game (an X11 window under Proton) all need it.
  if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

  // The app was called "PoE2 Upgrade Checker" before PoE1 support. Its settings, builds and log stay in that
  // folder (%APPDATA%\PoE2 Upgrade Checker, ~/.config/PoE2 Upgrade Checker), so nothing is lost by the rename.
  const DATA_DIR_NAME = 'PoE2 Upgrade Checker';
  if (app.isPackaged && path.basename(app.getPath('userData')) === app.getName() && app.getName() !== DATA_DIR_NAME) {
    app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR_NAME));
  }

  if (!app.requestSingleInstanceLock()) { app.exit(0); }

  return {
    withTimeout,
  };
};
