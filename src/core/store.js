'use strict';

const DEFAULT_BUILD = 'life-res'; // same as gearscore.DEFAULT_BUILD

// Tiny JSON-file store for equipped gear, stat weights and seen stats.

const fs = require('fs');
const path = require('path');

const DEFAULT_WEIGHTS = {
  '# to maximum Life': 1,
  '# to maximum Mana': 0.3,
  '#% to Fire Resistance': 1.5,
  '#% to Cold Resistance': 1.5,
  '#% to Lightning Resistance': 1.5,
  '#% to Chaos Resistance': 1,
  '# to Strength': 0.4,
  '# to Dexterity': 0.4,
  '# to Intelligence': 0.4,
  '#% increased Movement Speed': 3,
  '[Base] Armour': 0.05,
  '[Base] Evasion Rating': 0.05,
  '[Base] Energy Shield': 0.5,
  '[Base] Spirit': 1,
  '[Weapon] Total DPS': 1,
};

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'poe2-upgrade-checker.json');
    this.data = { weights: { ...DEFAULT_WEIGHTS }, equipped: {}, seenStats: {}, settings: { autoHideSeconds: 12, paused: false, hotkey: 'F2', watchClipboard: true, advancedCopy: false, autoRate: true, status: 'available' } };
    // never start from defaults over a file that's only temporarily unreadable (antivirus at login):
    // retry, then keep the broken file aside instead of overwriting everyone's gear and settings
    if (fs.existsSync(this.file)) {
      let loaded = null; let lastErr = null;
      for (let i = 0; i < 5 && !loaded; i++) {
        try { loaded = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (err) {
          lastErr = err;
          const until = Date.now() + 200; while (Date.now() < until) { /* short wait before retrying */ }
        }
      }
      if (!loaded && fs.existsSync(this.file + '.tmp')) { try { loaded = JSON.parse(fs.readFileSync(this.file + '.tmp', 'utf8')); } catch (_) { /* no */ } }
      if (loaded) {
        this.data = { ...this.data, ...loaded, settings: { ...this.data.settings, ...(loaded.settings || {}) } };
      } else {
        try { fs.copyFileSync(this.file, `${this.file}.unreadable-${Date.now()}`); } catch (_) { /* ignore */ }
        this.loadError = lastErr ? lastErr.message : 'unreadable';
      }
    }
    // Older versions kept advanced-copy notes in stat names; tidy saved items.
    const fixKey = (k) => (typeof k === 'string' ? k.replace(/\s+[—–-]+\s*Unscalable Value\s*$/i, '') : k);
    for (const it of Object.values(this.data.equipped || {})) {
      if (!it) continue;
      if (it.stats) it.stats = Object.fromEntries(Object.entries(it.stats).map(([k, v]) => [fixKey(k), v]));
      (it.lines || []).forEach((l) => { l.key = fixKey(l.key); });
    }
    this.initProfiles();
    if (!this.data.seenByClass) {
      this.data.seenByClass = {};
      for (const it of Object.values(this.data.equipped || {})) { try { this.noteStats(it); } catch (_) { /* ignore */ } }
    }
  }

  // ---------- characters (profiles) ----------
  // Each character has its own gear, weights, build, build tweaks, ignored
  // stats and resistances. The active one lives in the usual places; the
  // others are kept in data.profiles.
  initProfiles() {
    if (!this.data.profiles || !Object.keys(this.data.profiles).length) {
      this.data.profiles = { main: { name: 'My character' } };
      this.data.activeProfile = 'main';
    }
    if (!this.data.profiles[this.data.activeProfile]) this.data.activeProfile = Object.keys(this.data.profiles)[0];
  }

  snapshot() {
    const s = this.data.settings;
    return {
      equipped: this.data.equipped, weights: this.data.weights,
      ignoreStats: s.ignoreStats || [], build: s.build || DEFAULT_BUILD, buildTweaks: s.buildTweaks || {}, resists: s.resists || null,
    };
  }

  listProfiles() {
    return Object.entries(this.data.profiles).map(([id, p]) => ({ id, name: p.name, active: id === this.data.activeProfile }));
  }

  switchProfile(id) {
    if (!this.data.profiles[id] || id === this.data.activeProfile) return false;
    const cur = this.data.profiles[this.data.activeProfile];
    Object.assign(cur, this.snapshot());
    const next = this.data.profiles[id];
    this.data.activeProfile = id;
    this.data.equipped = next.equipped || {};
    this.data.weights = next.weights || { ...DEFAULT_WEIGHTS };
    Object.assign(this.data.settings, {
      ignoreStats: next.ignoreStats || [], build: next.build || DEFAULT_BUILD, buildTweaks: next.buildTweaks || {}, resists: next.resists || null,
    });
    this.save();
    return true;
  }

  createProfile(name, copyCurrent) {
    const id = 'p' + Date.now().toString(36);
    const base = copyCurrent ? JSON.parse(JSON.stringify(this.snapshot())) : { equipped: {}, weights: { ...DEFAULT_WEIGHTS }, ignoreStats: [], build: this.data.settings.build || DEFAULT_BUILD, buildTweaks: {}, resists: null };
    this.data.profiles[id] = { name: name || 'New character', ...base };
    this.switchProfile(id);
    return id;
  }

  renameProfile(id, name) {
    if (this.data.profiles[id] && name) { this.data.profiles[id].name = String(name).slice(0, 60); this.save(); }
  }

  deleteProfile(id) {
    const ids = Object.keys(this.data.profiles);
    if (!this.data.profiles[id] || ids.length < 2) return false;
    if (id === this.data.activeProfile) this.switchProfile(ids.find((x) => x !== id));
    delete this.data.profiles[id];
    this.save();
    return true;
  }

  save() {
    // keep the active character's stored copy in step (cheap: same objects)
    if (this.data.profiles && this.data.profiles[this.data.activeProfile]) {
      Object.assign(this.data.profiles[this.data.activeProfile], this.snapshot());
    }
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      // Windows: the indexer or antivirus can hold the file for a moment
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, this.file); break; } catch (err) {
          if (i >= 4) throw err;
          const until = Date.now() + 50 * (i + 1); while (Date.now() < until) { /* wait */ }
        }
      }
    } catch (err) { if (this.onError) this.onError(err); }
  }

  get weights() { return this.data.weights; }
  get equipped() { return this.data.equipped; }
  get settings() { return this.data.settings; }

  setWeight(key, value) {
    const n = Number(value);
    if (!key) return;
    if (!Number.isFinite(n) || n === 0) delete this.data.weights[key];
    else this.data.weights[key] = n;
    this.save();
  }

  replaceWeights(obj) {
    const clean = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n !== 0) clean[k] = n;
    }
    this.data.weights = clean;
    this.save();
  }

  resetWeights() { this.data.weights = { ...DEFAULT_WEIGHTS }; this.save(); }

  setEquipped(slot, item) {
    if (item) this.data.equipped[slot] = item; else delete this.data.equipped[slot];
    this.save();
  }

  // Remembers which stats you've seen, overall and per item class
  // ("seen on Gloves"), for the stat picker. Each item text counts once.
  noteStats(item) {
    let changed = false;
    for (const k of Object.keys(item.stats || {})) {
      if (!this.data.seenStats[k]) { this.data.seenStats[k] = 1; changed = true; }
    }
    const cls = item.itemClass;
    if (cls) {
      const sig = `${cls}|${item.name}|${(item.lines || []).map((l) => l.text).join('|')}`;
      this.data.seenItems = this.data.seenItems || {};
      if (!this.data.seenItems[sig]) {
        this.data.seenItems[sig] = 1;
        const keys = Object.keys(this.data.seenItems);
        if (keys.length > 2000) delete this.data.seenItems[keys[0]];
        this.data.seenByClass = this.data.seenByClass || {};
        const byClass = this.data.seenByClass[cls] = this.data.seenByClass[cls] || {};
        for (const k of Object.keys(item.stats || {})) byClass[k] = (byClass[k] || 0) + 1;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  setSetting(key, value) { this.data.settings[key] = value; this.save(); }
}

module.exports = { Store, DEFAULT_WEIGHTS };
