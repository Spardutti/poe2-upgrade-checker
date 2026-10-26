'use strict';

// Map / waystone check: each mod and what it means for your build (pob/server.lua mapCheck),
// with your own marks per game.
// Moved out of main.js: it reaches the app's shared state and helpers through C (see main.js).
const fs = require('fs');
const path = require('path');
const { app, ipcMain, shell } = require('electron');

module.exports = function (C) {
  const mapLib = require('../core/mapcheck');
  const mapMarks = () => ((C.store.settings.mapMarks || {})[C.tg()]) || {};
  let mapShown = null; // { r, pob } of the map on show, so a mark re-renders it
  function showMapCard(item) {
    const r = { ok: true, kind: 'map', item, links: C.ninjaLib.infoLinks(item, C.tg()), check: mapLib.check(item, null, mapMarks()), pending: C.pobOn(), noBuild: !C.pobOn() };
    mapShown = { r, pob: null };
    C.showResult(r);
    const seq = C.popupSeq;
    const send = () => { if (seq === C.popupSeq && C.popup && !C.popup.isDestroyed()) C.popup.webContents.send('popup:result', C.serialise(r)); };
    if (C.pobOn()) {
      C.pobEngine().mapCheck(mapLib.modsOf(item), require('../core/monstermods').enemyList(mapLib.modsOf(item))).then((res) => { mapShown.pob = res; r.check = mapLib.check(item, res, mapMarks()); })
        .catch((err) => { r.pobError = err.message; C.log('map check: ' + err.message); })
        .then(() => { r.pending = false; send(); });
    }
    C.ninjaPrice(item).then((p) => { if (p) { r.ninja = p; send(); } }).catch(() => {});
  }
  ipcMain.handle('map:mark', (_e, key, mark) => {
    if (typeof key !== 'string' || key.length > 300) return null;
    const all = { ...(C.store.settings.mapMarks || {}) };
    const mine = { ...(all[C.tg()] || {}) };
    if (mark) mine[key] = String(mark).slice(0, 1); else delete mine[key];
    all[C.tg()] = mine;
    C.store.setSetting('mapMarks', all);
    if (mapShown) {
      mapShown.r.check = mapLib.check(mapShown.r.item, mapShown.pob, mine);
      if (C.popup && !C.popup.isDestroyed()) C.popup.webContents.send('popup:result', C.serialise(mapShown.r));
    }
    return mine;
  });
  return { showMapCard };
};
