'use strict';

// Maps the "Item Class:" line from PoE2 (and PoE1) item text to an equipment slot, and
// lists every slot the app tracks. The slot lists are PoE2's (its UI uses them); PoE1 items map
// onto them where they fit (life/mana flasks, abyss and cluster jewels -> Jewel, quivers -> Offhand)
// and get no slot otherwise (utility and hybrid flasks, tinctures).

// Main gear first (these make up your gear score), then the extras.
const MAIN_SLOTS = [
  'Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots',
  'Belt', 'Amulet', 'Ring 1', 'Ring 2',
];
// Jewel sockets: a build can have many (PoE1 trees with cluster jewels have dozens). The app
// keeps up to JEWEL_MAX and shows the first JEWEL_SHOWN, plus any that hold a jewel and one
// empty one after them (visibleJewels).
const JEWEL_MAX = 40;
const JEWEL_SHOWN = 6;
const JEWEL_SLOTS = Array.from({ length: JEWEL_MAX }, (_, i) => `Jewel ${i + 1}`);
const EXTRA_SLOTS = [
  'Weapon 2', 'Offhand 2',
  'Life Flask', 'Mana Flask', 'Charm 1', 'Charm 2', 'Charm 3',
  ...JEWEL_SLOTS,
];
const SLOTS = [...MAIN_SLOTS, ...EXTRA_SLOTS];

// An item of one kind can go in any of these slots (you choose with "Set as …").
// The first one is what it's compared with, except Ring/Charm/Jewel which are
// compared with your weakest one.
const SLOT_GROUPS = {
  Weapon: ['Weapon', 'Weapon 2'],
  Offhand: ['Offhand', 'Offhand 2'],
  Ring: ['Ring 1', 'Ring 2'],
  Charm: ['Charm 1', 'Charm 2', 'Charm 3'],
  Jewel: JEWEL_SLOTS,
};
const WEAKEST_OF = ['Ring', 'Charm', 'Jewel'];

const CLASS_TO_SLOT = {
  'helmets': 'Helmet',
  'body armours': 'Body Armour',
  'gloves': 'Gloves',
  'boots': 'Boots',
  'belts': 'Belt',
  'amulets': 'Amulet',
  'rings': 'Ring',
  'shields': 'Offhand',
  'bucklers': 'Offhand',
  'foci': 'Offhand',
  'quivers': 'Offhand',
  'jewels': 'Jewel',
  'charms': 'Charm',
  'life flasks': 'Life Flask',
  'mana flasks': 'Mana Flask',
  // PoE1
  'abyss jewels': 'Jewel',
  'fishing rods': 'Weapon',
};
// PoE1 classes that are gear but have no slot in the shared lists
const NO_SLOT = ['utility flasks', 'hybrid flasks', 'tinctures'];

const WEAPON_WORDS = [
  'mace', 'sword', 'axe', 'bow', 'crossbow', 'quarterstave', 'staves', 'stave',
  'wand', 'sceptre', 'spear', 'flail', 'dagger', 'claw', 'talisman', 'warstave',
];

// Bows are two-handed in both games but stay off this list: a bow is used with a quiver in the
// offhand, so it is compared with your weapon alone.
const TWO_HANDED_PREFIXES = ['two hand', 'quarterstaves', 'staves', 'crossbows', 'warstaves', 'talismans', 'fishing rods'];

function slotForClass(itemClass) {
  if (!itemClass) return null;
  const c = itemClass.trim().toLowerCase();
  if (CLASS_TO_SLOT[c]) return CLASS_TO_SLOT[c];
  if (NO_SLOT.includes(c)) return null;
  if (/jewel/.test(c)) return 'Jewel';
  if (/flask/.test(c)) return /mana/.test(c) ? 'Mana Flask' : 'Life Flask';
  if (WEAPON_WORDS.some((w) => c.includes(w))) return 'Weapon';
  return null; // currency, gems, waystones etc. are not gear
}

function isTwoHanded(itemClass) {
  if (!itemClass) return false;
  const c = itemClass.trim().toLowerCase();
  return TWO_HANDED_PREFIXES.some((p) => c.startsWith(p));
}

// "Ring 2" -> "Ring", "Weapon 2" -> "Weapon", "Jewel 4" -> "Jewel"
function groupOf(slot) {
  for (const [g, list] of Object.entries(SLOT_GROUPS)) if (list.includes(slot)) return g;
  return slot;
}

// the jewel slots worth showing: the first JEWEL_SHOWN, every one that holds a jewel, and one
// empty slot after the last filled one (so you can always add another)
function visibleJewels(equipped) {
  let last = 0;
  JEWEL_SLOTS.forEach((s, i) => { if (equipped && equipped[s]) last = i + 1; });
  return JEWEL_SLOTS.slice(0, Math.min(JEWEL_MAX, Math.max(JEWEL_SHOWN, last + 1)));
}

module.exports = { SLOTS, JEWEL_SLOTS, JEWEL_MAX, JEWEL_SHOWN, visibleJewels, MAIN_SLOTS, EXTRA_SLOTS, SLOT_GROUPS, WEAKEST_OF, slotForClass, isTwoHanded, groupOf };
