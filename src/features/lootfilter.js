'use strict';

// A loot filter section from your build, saved as a copy of your own filter.
// Moved out of main.js: it reaches the app's shared state and helpers through C (see main.js).
const fs = require('fs');
const path = require('path');
const { app, ipcMain, shell } = require('electron');

module.exports = function (C) {
  const filterLib = require('../core/lootfilter');
  function filterFolder() {
    const docs = app.getPath('documents');
    const dir = path.join(docs, 'My Games', C.tg() === 'poe1' ? 'Path of Exile' : 'Path of Exile 2');
    return fs.existsSync(dir) ? dir : docs;
  }
  ipcMain.handle('filter:make', C.inGame(async () => {
    if (!C.pobOn()) return { ok: false, error: 'Load your Path of Building build first: the filter is made from what your build needs.' };
    const game = C.tg();
    const eng = C.pobEngine();
    await eng.ensureLoaded();
    const plan = [];
    for (const slot of ['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Weapon', 'Offhand']) {
      const it = C.store.equipped[slot];
      const p = { slot: slot.replace(/ \d$/, ''), cls: it && it.itemClass, bases: it && !/unique/i.test(it.rarity || '') && it.baseType ? [it.baseType] : [], affixes: [] };
      const tags = filterLib.tagsFor(slot, it);
      if (tags && it && !(slot === 'Ring 2' && plan.some((x) => x.slot === 'Ring' && x.affixes.length))) {
        try {
          const qy = await C.pobQueryFor(slot, it);
          const ids = (qy.modWeights || []).filter((m) => /^explicit\./.test(m.id) && m.weight > 0).slice(0, 8).map((m) => m.id);
          const names = ids.length ? await eng.affixes({ ids, tags, tiers: 3 }) : {};
          p.affixes = ids.flatMap((id) => (names[id] || []).filter((m, i) => i === 0 || m.level >= 20).map((m) => m.affix));
        } catch (err) { C.log(`filter: ${slot}: ${err.message}`); }
      }
      if (!C.sameGame()) return C.SWITCHED();
      plan.push(p);
    }
    const prof = C.store.listProfiles().find((x) => x.active);
    const section = filterLib.build(plan, { game, name: prof && prof.name });
    if (!section.blocks) return { ok: false, error: 'Nothing to put in a filter yet: save your gear on My gear first.' };
    const { dialog } = require('electron');
    const pick = await dialog.showOpenDialog(C.settingsWin && !C.settingsWin.isDestroyed() ? C.settingsWin : undefined, {
      title: 'Pick the loot filter you use now (Cancel: save this section on its own)', defaultPath: filterFolder(), properties: ['openFile'], filters: [{ name: 'Loot filters', extensions: ['filter'] }],
    });
    let existing = ''; let base = `${C.G(game).short} upgrades`; let dir = filterFolder();
    if (!pick.canceled && pick.filePaths && pick.filePaths[0]) {
      try { existing = fs.readFileSync(pick.filePaths[0], 'utf8'); } catch (err) { return { ok: false, error: `Couldn't read that filter: ${err.message}` }; }
      base = path.basename(pick.filePaths[0], '.filter').replace(/ \+ upgrades$/i, '') + ' + upgrades'; dir = path.dirname(pick.filePaths[0]);
    }
    const save = await dialog.showSaveDialog(C.settingsWin && !C.settingsWin.isDestroyed() ? C.settingsWin : undefined, {
      title: 'Save the loot filter', defaultPath: path.join(dir, base + '.filter'), filters: [{ name: 'Loot filters', extensions: ['filter'] }],
    });
    if (save.canceled || !save.filePath) return { ok: false, error: 'Not saved.' };
    if (pick.filePaths && save.filePath === pick.filePaths[0]) return { ok: false, error: 'Save it under a new name: your own filter stays as it is.' };
    try { fs.writeFileSync(save.filePath, existing ? filterLib.merge(section, existing) : section.text); } catch (err) { return { ok: false, error: `Couldn't save it: ${err.message}` }; }
    C.log(`filter: saved ${save.filePath} (${section.blocks} blocks)`);
    return { ok: true, file: save.filePath, message: `Saved "${path.basename(save.filePath)}" with ${section.modBlocks ? `${section.modBlocks} slot${section.modBlocks === 1 ? '' : 's'} of mod highlights and ` : ''}${section.bases} base${section.bases === 1 ? '' : 's'}. In the game: Options → Game → Item Filter, pick it, then reload.` };
  }));
  return { filterFolder };
};
