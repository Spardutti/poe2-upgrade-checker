-- PoE Upgrade Checker <-> Path of Building bridge.
-- Runs Path of Building's own calculations headless and answers JSON requests, one per line:
--   {"id":1,"cmd":"load","xml":"<PathOfBuilding2>…"}        -> summary of the build
--   {"id":2,"cmd":"eval","items":[{"slot":"Gloves","text":"Item Class: …"}]} -> what each item changes
-- Replies are single lines starting with "@@" (PoB's own log output goes to stderr).
-- Started with the PoB "src" folder as the working directory.

-- the standalone luajit sets the command line in `arg`; PoB reads it, and our Windows host doesn't set it
arg = arg or { [0] = "server.lua" }

-- where Path of Building's runtime libraries are (set by the app when it starts us)
local hostDir = os.getenv("POBHOST_DIR")
if hostDir and hostDir ~= "" then
  local sep = package.config:sub(1, 1)
  package.cpath = hostDir .. sep .. "?.dll;" .. hostDir .. sep .. "?.so;" .. package.cpath
end
local luaPath = os.getenv("POB_LUA_PATH")
if luaPath and luaPath ~= "" then package.path = luaPath .. ";" .. package.path end

-- which Path of Building this is: "poe2" (Path of Building 2) or "poe1" (Path of Building Community);
-- set by the app (pobengine.js). The commands are the same for both.
local GAME = os.getenv("POB_GAME") == "poe1" and "poe1" or "poe2"

local out = io.stdout
local function reply(t) out:write("@@", t, "\n"); out:flush() end
-- PoB prints a lot while it loads: keep stdout for replies only
local recent = {}
print = function(...)
  local n = select('#', ...); local p = {}
  for i = 1, n do p[i] = tostring((select(i, ...))) end
  local line = table.concat(p, "\t")
  io.stderr:write(line, "\n")
  recent[#recent + 1] = line
  if #recent > 30 then table.remove(recent, 1) end
end

-- PoB's files start with a "#@" line its own launcher understands; plain LuaJIT doesn't
local rawDofile = dofile
dofile = function(path)
  local f = io.open(path, "rb")
  if not f then return rawDofile(path) end
  local src = f:read("*a"); f:close()
  src = src:gsub("^#[^\n]*", "")
  return assert(loadstring(src, "@" .. path))()
end

-- lua-utf8 is a native module next to lua51.dll; if it won't load, a plain-Lua stand-in keeps
-- PoB working (it only uses it for a few string functions on item and skill names)
if not pcall(require, "lua-utf8") then
  io.stderr:write("lua-utf8 not available, using a plain Lua stand-in\n")
  package.loaded["lua-utf8"] = nil
  package.preload["lua-utf8"] = function()
    local u = {}
    u.find, u.gsub, u.match, u.sub, u.reverse, u.len, u.lower, u.upper, u.format, u.byte, u.char = string.find, string.gsub, string.match, string.sub, string.reverse, string.len, string.lower, string.upper, string.format, string.byte, string.char
    u.next = function(s, i) i = (i or 0) + 1; if i > #s then return nil end; local c = s:byte(i); local n = c >= 240 and 4 or c >= 224 and 3 or c >= 192 and 2 or 1; return i, s:sub(i, i + n - 1) end
    return u
  end
end

-- PoB1 headless: _SimpleGraphic.def.lua stubs Inflate() to return "", which breaks timeless jewel
-- data (Data/TimelessJewelData/*.zip are zlib streams). Give it a real one through LuaJIT's FFI and zlib.
local function installInflate()
  local ok, ffi = pcall(require, "ffi")
  if not ok then return end
  pcall(ffi.cdef, [[
    typedef struct { const unsigned char *next_in; unsigned int avail_in; unsigned long total_in;
      unsigned char *next_out; unsigned int avail_out; unsigned long total_out;
      const char *msg; void *state; void *zalloc; void *zfree; void *opaque;
      int data_type; unsigned long adler; unsigned long reserved; } pob_z_stream;
    const char *zlibVersion(void);
    int inflateInit2_(pob_z_stream *strm, int windowBits, const char *version, int stream_size);
    int inflate(pob_z_stream *strm, int flush);
    int inflateEnd(pob_z_stream *strm);
  ]])
  local z
  for _, name in ipairs({ "z", "libz.so.1", "zlib1", "zlib" }) do
    local okl, lib = pcall(ffi.load, name); if okl then z = lib; break end
  end
  if not z then io.stderr:write("zlib not found: timeless jewels won't work\n"); return end
  local CHUNK = 1048576
  local buf = ffi.new("unsigned char[?]", CHUNK)
  return function(data)
    if not data or #data == 0 then return "" end
    local strm = ffi.new("pob_z_stream")
    if z.inflateInit2_(strm, 15 + 32, z.zlibVersion(), ffi.sizeof(strm)) ~= 0 then return "" end
    strm.next_in = ffi.cast("const unsigned char *", data); strm.avail_in = #data
    local parts, rc = {}, 0
    repeat
      strm.next_out = buf; strm.avail_out = CHUNK
      rc = z.inflate(strm, 0)
      if rc ~= 0 and rc ~= 1 then break end
      parts[#parts + 1] = ffi.string(buf, CHUNK - strm.avail_out)
    until rc == 1
    z.inflateEnd(strm)
    return rc == 1 and table.concat(parts) or ""
  end
end
local realInflate = GAME == "poe1" and installInflate() or nil

-- PoB waits for Enter when it can't start; we're not a console, so don't let it block
local rawRead = io.read
local starting = true
io.read = function(...) if starting then return nil end; return rawRead(...) end
dofile("HeadlessWrapper.lua")
starting = false
io.read = rawRead
if realInflate then Inflate = realInflate end
local dkjson = require("dkjson")
-- PoB's launch object (it holds promptMsg, PoB's error message). PoB2's HeadlessWrapper keeps it in a
-- local, PoB1's in the global __mainObject__; SetMainObject has it as an upvalue in both.
local mainObject = rawget(_G, "mainObject") or rawget(_G, "__mainObject__")
if not mainObject and type(SetMainObject) == "function" then
  for i = 1, 20 do
    local n, v = debug.getupvalue(SetMainObject, i)
    if not n then break end
    if n == "mainObject" then mainObject = v; break end
  end
end
if not build or (mainObject and mainObject.promptMsg) then
  local msg = tostring(mainObject and mainObject.promptMsg or table.concat(recent, "\n"))
  msg = msg:gsub("%^%d", ""):gsub("%^x%x%x%x%x%x%x", "")
  out:write("@@", dkjson.encode({ ready = false, error = msg }), "\n"); out:flush()
  os.exit(1)
end

local function enc(v) return dkjson.encode(v) end

-- the numbers we report, read safely from a PoB output table
local function num(v) v = tonumber(v); if v == nil or v ~= v or v == math.huge or v == -math.huge then return nil end; return v end
local function pick(o)
  if not o then return {} end
  local m = o.Minion or {}
  local r = {
    FullDPS = num(o.FullDPS), CombinedDPS = num(o.CombinedDPS), TotalDPS = num(o.TotalDPS),
    MinionDPS = num(m.CombinedDPS) or num(m.TotalDPS), AverageHit = num(o.AverageHit) or num(o.MainHand and o.MainHand.AverageHit), MinionAverageHit = num(m.AverageHit) or num(m.MainHand and m.MainHand.AverageHit), MinionLife = num(m.Life), MinionES = num(m.EnergyShield),
    Life = num(o.Life), EnergyShield = num(o.EnergyShield), Mana = num(o.Mana), Ward = num(o.Ward),
    TotalEHP = num(o.TotalEHP), Armour = num(o.Armour), Evasion = num(o.Evasion),
    Spirit = num(o.Spirit), SpiritUnreserved = num(o.SpiritUnreserved), ManaUnreserved = num(o.ManaUnreserved),
    -- PoE1: reservation instead of Spirit, block and spell suppression
    ManaUnreservedPercent = num(o.ManaUnreservedPercent), LifeUnreserved = num(o.LifeUnreserved), LifeUnreservedPercent = num(o.LifeUnreservedPercent),
    ManaReserved = num(o.ManaReserved), LifeReserved = num(o.LifeReserved),
    BlockChance = num(o.BlockChance), SpellSuppressionChance = num(o.SpellSuppressionChance),
    Str = num(o.Str), Dex = num(o.Dex), Int = num(o.Int),
    ReqStr = num(o.ReqStr), ReqDex = num(o.ReqDex), ReqInt = num(o.ReqInt),
    MovementSpeedMod = num(o.MovementSpeedMod), LifeRegenRecovery = num(o.LifeRegenRecovery),
  }
  for _, el in ipairs({ "Fire", "Cold", "Lightning", "Chaos" }) do
    r[el .. "Resist"] = num(o[el .. "Resist"])
    r[el .. "ResistTotal"] = num(o[el .. "ResistTotal"])
    r[el .. "ResistOverCap"] = num(o[el .. "ResistOverCap"])
    -- PoB doesn't output the max itself, but it does output how much you're missing
    local res, missing = r[el .. "Resist"], num(o["Missing" .. el .. "Resist"])
    r[el .. "ResistMax"] = (res and missing) and (res + missing) or nil
  end
  return r
end

-- PoB releases build items with new("Item", text); its dev branch with new("Item"):Item(text)
-- the bundled Path of Building's version ("2.67.2"), from its launch object or its manifest
local pobVersionCache
local function pobVersion()
  if pobVersionCache ~= nil then return pobVersionCache or nil end
  local o = mainObject or rawget(_G, "launch")
  local v = o and o.versionNumber
  if not v then
    for _, p in ipairs({ "../manifest.xml", "manifest.xml" }) do
      local f = io.open(p, "r")
      if f then v = (f:read("*a") or ""):match('<Version number="([%d%.]+)"'); f:close() end
      if v then break end
    end
  end
  pobVersionCache = v or false
  return v
end

local function makeItem(text)
  local ok, item = pcall(new, "Item", text)
  if ok and item and item.base then return item end
  local ok2, item2 = pcall(function() return new("Item"):Item(text) end)
  if ok2 and item2 and item2.base then return item2 end
  return nil
end

-- a build set to weapon set II keeps its active weapons in PoB's "Weapon 1 Swap"/"Weapon 2 Swap" slots
local function pobSlot(name)
  local set = build.itemsTab.activeItemSet
  if name and name:match("^Weapon [12]$") and set and set.useSecondWeaponSet then return name .. " Swap" end
  return name
end

local SLOTS = { "Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt" }
if GAME == "poe1" then for _, n in ipairs({ "Ring 3", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5" }) do SLOTS[#SLOTS + 1] = n end end
local function gearNames()
  local g = {}
  for _, name in ipairs(SLOTS) do
    local slot = build.itemsTab.slots[pobSlot(name)]
    local it = slot and slot.selItemId and build.itemsTab.items[slot.selItemId]
    if it then g[name] = it.title or it.name end
  end
  return g
end

-- put items you copied in game into PoB's build, so it calculates with what you really wear
local function equip(list)
  local done = {}
  for _, e in ipairs(list or {}) do
    local item = makeItem(e.text)
    local slot = build.itemsTab.slots[pobSlot(e.slot)]
    if item and slot then
      build.itemsTab:AddItem(item, true)
      slot:SetSelItemId(item.id)
      done[#done + 1] = e.slot
    end
  end
  build.itemsTab:PopulateSlots()
  build.buildFlag = true
  runCallback("OnFrame")
  return done
end

-- your allocated jewel sockets on the passive tree, in PoB's order ("Socket #1"…), with what's in them
local function jewelSockets()
  local list = {}
  local it = build.itemsTab
  -- PoB refreshes activeSocketList only while drawing, so read the allocated sockets ourselves
  local ids = {}
  for nodeId in pairs(it.sockets or {}) do if build.spec.allocNodes[nodeId] then ids[#ids + 1] = nodeId end end
  table.sort(ids)
  for n, nodeId in ipairs(ids) do
    local sock = it.sockets[nodeId]
    sock.inactive = false
    if sock then
      local node = build.spec.nodes[nodeId]
      -- sockets made by cluster-style jewels (containJewelSocket) aren't on the main tree
      if not (node and node.containJewelSocket) then
        local jewel = sock.selItemId and sock.selItemId ~= 0 and it.items[sock.selItemId] or nil
        list[#list + 1] = { slot = sock.slotName, nodeId = nodeId, label = "Socket #" .. n, jewel = jewel and (jewel.title or jewel.name) or nil,
          -- PoE1: swapping out a cluster jewel keeps its passives allocated in PoB's quick calculation,
          -- so a result there overstates; the app doesn't trust it
          cluster = (jewel and jewel.clusterJewel) and true or nil }
      end
    end
  end
  -- PoE1: abyssal sockets on your gear ("Belt Abyssal Socket 1"…), for items that have them
  for _, name in ipairs(SLOTS) do
    local parent = it.slots[pobSlot(name)]
    local item = parent and parent.selItemId and it.items[parent.selItemId]
    for i = 1, (item and item.abyssalSocketCount or 0) do
      local s = parent.abyssalSocketList and parent.abyssalSocketList[i]
      if s then
        local jewel = s.selItemId and s.selItemId ~= 0 and it.items[s.selItemId] or nil
        list[#list + 1] = { slot = s.slotName, label = name .. " Abyssal #" .. i, abyssal = true, jewel = jewel and (jewel.title or jewel.name) or nil }
      end
    end
  end
  return list
end

-- PoE1: how many gems your biggest socket group in each gear slot uses, so an item with fewer
-- links can be flagged (PoB's quick calculation keeps your gems linked whatever the new item has)
local function slotGems()
  if GAME ~= "poe1" then return nil end
  local r = {}
  for _, g in ipairs(build.skillsTab.socketGroupList or {}) do
    -- weapon swap: only the weapon set the build is using counts
    local swap = tostring(g.slot or ""):match(" Swap$") ~= nil
    local set = build.itemsTab.activeItemSet
    local second = set and set.useSecondWeaponSet
    if g.slot and g.enabled ~= false and not g.source and (not tostring(g.slot):match("^Weapon") or swap == (second and true or false)) then
      local n = 0
      local col = { R = 0, G = 0, B = 0, W = 0 }
      local names = { "R", "G", "B" }
      for _, gem in ipairs(g.gemList or {}) do
        local ge = gem.grantedEffect or (gem.gemData and gem.gemData.grantedEffect)
        if gem.enabled ~= false and (gem.gemData or gem.grantedEffect) then
          n = n + 1
          local c = ge and ge.color and names[ge.color] or "W"
          col[c] = col[c] + 1
        end
      end
      local slot = tostring(g.slot):gsub(" Swap$", "")
      if n > 0 and (not r[slot] or n > r[slot].gems) then r[slot] = { gems = n, label = g.displayLabel or g.label, colours = col } end
    end
  end
  return r
end

-- PoE1: what kind of weapon/offhand each weapon slot holds ("Two Handed Axe", "One Handed Sword"
-- + "Thrusting"), so imported items get their real item class (the export doesn't say)
local function gearTypes()
  if GAME ~= "poe1" then return nil end
  local r = {}
  for _, name in ipairs({ "Weapon 1", "Weapon 2", "Weapon 1 Swap", "Weapon 2 Swap" }) do
    local slot = build.itemsTab.slots[name]
    local it = slot and slot.selItemId and build.itemsTab.items[slot.selItemId]
    if it and it.base then r[name] = { type = it.base.type, subType = it.base.subType, name = it.title or it.name } end
  end
  return r
end

local function summary()
  local o = build.calcsTab.mainOutput
  local okt, types = pcall(gearTypes)
  local skill = build.mainSocketGroup and build.skillsTab.socketGroupList[build.mainSocketGroup]
  local okg, gems = pcall(slotGems)
  return {
    slotGems = okg and gems or nil, gearTypes = okt and types or nil,
    ok = true, game = GAME, treeVersion = build.spec and build.spec.treeVersion,
    className = build.spec and build.spec.curClassName, ascendancy = build.spec and build.spec.curAscendClassName,
    level = build.characterLevel,
    mainSkill = skill and skill.displayLabel or nil,
    stats = pick(o),
    gear = gearNames(),
    sockets = jewelSockets(),
  }
end

-- Everything worth showing on a character sheet: the PoB numbers (yours and your minions'),
-- skills with their gems, keystones and ascendancy notables. Each part is read on its own, so one
-- PoB version difference can't break the whole sheet.
local function grab(o, keys)
  local r = {}
  if not o then return r end
  for _, k in ipairs(keys) do
    local v = o[k]
    -- dual wielding: PoB keeps some per-hit numbers on the main hand only
    if v == nil and o.MainHand and (k == "AverageHit" or k == "CritChance" or k == "CritMultiplier" or k == "HitChance" or k == "Accuracy") then v = o.MainHand[k] end
    if type(v) == "boolean" then r[k] = v else r[k] = num(v) end
  end
  return r
end
local PLAYER_KEYS = {
  "FullDPS", "TotalDPS", "CombinedDPS", "TotalDotDPS", "AverageHit", "Speed", "CritChance", "CritMultiplier", "HitChance", "Accuracy",
  "Life", "LifeUnreserved", "LifeRegenRecovery", "EnergyShield", "EnergyShieldRecharge", "EnergyShieldRechargeDelay", "EnergyShieldRegenRecovery",
  "Mana", "ManaUnreserved", "ManaRegenRecovery", "Ward", "WardRechargeDelay",
  "Spirit", "SpiritReserved", "SpiritUnreserved",
  "LifeUnreservedPercent", "ManaUnreservedPercent", "LifeReserved", "ManaReserved", "SpellSuppressionChance", "EffectiveSpellSuppressionChance",
  "TotalEHP", "EHPSurvivalTime", "Armour", "Evasion", "EvadeChance", "PhysicalDamageReduction",
  "BlockChance", "BlockChanceMax", "SpellBlockChance", "DeflectChance", "DeflectionRating", "StunAvoidChance", "StunThreshold", "AilmentThreshold",
  "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken", "LightningMaximumHitTaken", "ChaosMaximumHitTaken",
  "Str", "Dex", "Int", "ReqStr", "ReqDex", "ReqInt",
  "MovementSpeedMod", "EffectiveMovementSpeedMod",
  "PowerCharges", "PowerChargesMax", "FrenzyCharges", "FrenzyChargesMax", "EnduranceCharges", "EnduranceChargesMax",
  "ChaosInoculation", "TotalCompanionLife", "PresenceRadiusMetres",
}
local MINION_KEYS = {
  "CombinedDPS", "TotalDPS", "AverageHit", "Speed", "CastRate", "CritChance", "CritMultiplier", "HitChance", "Cooldown",
  "Life", "EnergyShield", "Armour", "Evasion", "TotalEHP", "PhysicalDamageReduction", "BlockChance",
  "FireResist", "ColdResist", "LightningResist", "ChaosResist", "AreaOfEffectRadiusMetres",
}
local function sheet()
  local o = build.calcsTab.mainOutput or {}
  local r = summary()
  r.player = grab(o, PLAYER_KEYS)
  r.res = {}
  for _, el in ipairs({ "Fire", "Cold", "Lightning", "Chaos" }) do
    local v, missing = num(o[el .. "Resist"]), num(o["Missing" .. el .. "Resist"])
    r.res[#r.res + 1] = { el = el, value = v, total = num(o[el .. "ResistTotal"]), over = num(o[el .. "ResistOverCap"]), max = (v and missing) and (v + missing) or nil }
  end
  if o.Minion then
    r.minion = grab(o.Minion, MINION_KEYS)
    pcall(function()
      local ms = build.calcsTab.mainEnv.player.mainSkill
      r.minion.name = ms and ms.minion and ms.minion.minionData and ms.minion.minionData.name or nil
    end)
  end
  -- skills: every socket group with its gems (the main one marked)
  pcall(function()
    r.skills = {}
    for i, g in ipairs(build.skillsTab.socketGroupList or {}) do
      local gems = {}
      for _, gem in ipairs(g.gemList or {}) do
        local name = gem.nameSpec or (gem.grantedEffect and gem.grantedEffect.name)
        if name and name ~= "" then gems[#gems + 1] = { name = name, level = num(gem.level), quality = num(gem.quality), enabled = gem.enabled ~= false, support = not not ((gem.grantedEffect and gem.grantedEffect.support) or (gem.gemData and gem.gemData.grantedEffect and gem.gemData.grantedEffect.support) or (gem.gemData and gem.gemData.tags and gem.gemData.tags.support)) } end
      end
      if #gems > 0 then
        r.skills[#r.skills + 1] = { label = g.displayLabel or g.label, enabled = g.enabled ~= false, main = (i == build.mainSocketGroup), slot = g.slot, gems = gems }
      end
    end
  end)
  -- passive tree: keystones, ascendancy notables, notables and points used
  pcall(function()
    local key, asc, notables, points = {}, {}, {}, 0
    for _, node in pairs(build.spec.allocNodes or {}) do
      local t = node.type
      if t ~= "ClassStart" and t ~= "AscendClassStart" then
        if node.ascendancyName then
          if t == "Notable" or node.isNotable then asc[#asc + 1] = node.dn end
        else
          points = points + 1
          if t == "Keystone" then key[#key + 1] = node.dn
          elseif t == "Notable" then notables[#notables + 1] = node.dn end
        end
      end
    end
    local function uniq(t) table.sort(t); local o, last = {}, nil; for _, v in ipairs(t) do if v ~= last then o[#o + 1] = v end; last = v end; return o end
    key, asc, notables = uniq(key), uniq(asc), uniq(notables)
    r.tree = { keystones = key, ascendancy = asc, notables = notables, points = points }
  end)
  return r
end

local function evalItems(items)
  local calcFunc, base = build.calcsTab:GetMiscCalculator()
  local res = {}
  for i, it in ipairs(items) do
    local ok, r = pcall(function()
      local item = makeItem(it.text)
      if not item then return { ok = false, error = "Path of Building couldn't read this item" .. (pobVersion() and (" (it may be newer than the Path of Building " .. pobVersion() .. " in this app)") or "") } end
      local slot = it.slot
      if slot == "Jewel" then
        -- try it in every allocated socket: replacing the jewel there, or in an empty one
        local multi = {}
        for _, s in ipairs(jewelSockets()) do
          if build.itemsTab:IsItemValidForSlot(item, s.slot) then
            local new_ = calcFunc({ repSlotName = s.slot, repItem = item })
            multi[#multi + 1] = { slot = s.slot, label = s.label, replacing = s.jewel, replacingCluster = s.cluster, abyssal = s.abyssal, after = pick(new_) }
          end
        end
        if #multi == 0 then return { ok = false, error = "You have no allocated jewel socket this jewel fits" } end
        return { ok = true, slot = slot, before = pick(base), multi = multi }
      end
      if slot == "Flask" and GAME == "poe1" then
        -- a flask or tincture: tried in each of your five flask slots. PoB only counts a flask whose
        -- slot is switched on ("active"), so each slot is switched on for the check, before and after
        -- alike, then put back as it was.
        local multi = {}
        local nf = function(it_) local d = it_ and it_.flaskData; if not d then return nil end
          return { life = num(d.lifeTotal), mana = num(d.manaTotal), duration = num(d.duration), charges = num(d.chargesMax), used = num(d.chargesUsed), effect = num(d.effectInc) } end
        for n = 1, 5 do
          local s = build.itemsTab.slots["Flask " .. n]
          if s and build.itemsTab:IsItemValidForSlot(item, s.slotName) then
            local cur = s.selItemId and build.itemsTab.items[s.selItemId]
            local was = s.active
            s.active = true
            local okb, b = pcall(calcFunc, {})
            local oka, a = pcall(calcFunc, { repSlotName = s.slotName, repItem = item })
            s.active = was
            if okb and oka then
              multi[#multi + 1] = { slot = s.slotName, label = s.slotName, replacing = cur and (cur.title or cur.name) or nil,
                replacingBase = cur and cur.baseName or nil, replacingType = cur and cur.base and cur.base.type or nil,
                replacingSub = cur and cur.base and cur.base.subType or nil, active = was and true or false,
                before = pick(b), after = pick(a), replacingFlask = nf(cur) }
            end
          end
        end
        if #multi == 0 then return { ok = false, error = "Path of Building has no flask slot this fits" } end
        return { ok = true, slot = slot, before = pick(base), multi = multi, flask = nf(item),
          base = item.baseName, type = item.base and item.base.type, sub = item.base and item.base.subType }
      end
      local pslot = pobSlot(slot)
      -- PoB empties the offhand itself for most two-handers, but not crossbows or quarterstaves
      local off, offId
      local info = item.base and data.weaponTypeInfo[item.base.type]
      if pslot:match("^Weapon 1") and info and not info.oneHand and (item.base.type == "Crossbow" or item.base.type == "Warstaff" or item.base.type == "Fishing Rod" or item.base.type == "Bow") then
        off = build.itemsTab.slots[pslot:gsub("^Weapon 1", "Weapon 2")]
        local offItem = off and off.selItemId and build.itemsTab.items[off.selItemId]
        -- a bow keeps its quiver; anything else in the offhand goes
        if item.base.type == "Bow" and offItem and offItem.base and offItem.base.type == "Quiver" then off = nil end
        if off then offId = off.selItemId; off.selItemId = 0 end
      end
      local okc, new_ = pcall(calcFunc, { repSlotName = pslot, repItem = item })
      if off then off.selItemId = offId end
      if not okc then error(new_) end
      return { ok = true, slot = slot, before = pick(base), after = pick(new_) }
    end)
    res[i] = ok and r or { ok = false, error = tostring(r) }
  end
  return res
end

-- Two items at once ("a ring and boots that cap your resistances together"): each first item is
-- put on for real, every second item is tried with it, then your gear goes back as it was.
--   pairs: { { a = {slot, text}, bs = { {slot, text}, ... } }, ... } -> { { before, results = { after|error } } }
local function evalPairs(pairs)
  local _, base0 = build.calcsTab:GetMiscCalculator()
  local before = pick(base0)
  local out = {}
  for i, p in ipairs(pairs or {}) do
    local res = { results = {} }
    local ok, err = pcall(function()
      local slotA = build.itemsTab.slots[pobSlot(p.a.slot)]
      local itemA = makeItem(p.a.text)
      if not (slotA and itemA) then error("Path of Building couldn't read the first item") end
      local orig = slotA.selItemId
      build.itemsTab:AddItem(itemA, true)
      slotA:SetSelItemId(itemA.id)
      build.itemsTab:PopulateSlots(); build.buildFlag = true; runCallback("OnFrame")
      local okc, e2 = pcall(function()
        local calcFunc = build.calcsTab:GetMiscCalculator()
        for k, b in ipairs(p.bs or {}) do
          local itemB = makeItem(b.text)
          if itemB then
            local okb, new_ = pcall(calcFunc, { repSlotName = pobSlot(b.slot), repItem = itemB })
            res.results[k] = okb and { ok = true, after = pick(new_) } or { ok = false, error = tostring(new_) }
          else res.results[k] = { ok = false, error = "Path of Building couldn't read this item" } end
        end
      end)
      -- your gear back as it was, whatever happened
      slotA:SetSelItemId(orig or 0)
      if build.itemsTab.DeleteItem then pcall(build.itemsTab.DeleteItem, build.itemsTab, itemA) end
      build.itemsTab:PopulateSlots(); build.buildFlag = true; runCallback("OnFrame")
      if not okc then error(e2) end
    end)
    if not ok then res.error = tostring(err) end
    res.ok = ok
    res.before = before
    out[i] = res
  end
  return out
end

-- What a map's or waystone's mods do to you. Mods that act on the player ("Players have -10% to all
-- maximum Resistances") are read by PoB's own mod parser and added for the calculation, one at a
-- time and then all together; the rest are only reported as not calculated. Also: what your main
-- skill's damage is made of and whether it leeches, for the app's own checks (reflect, no leech).
local function variants(text)
  local t = tostring(text or ""):gsub("%s+$", "")
  local out = { t }
  local rest = t:match("^[Pp]layers have (.+)$")
  if rest then out[#out + 1] = rest end
  rest = t:match("^[Pp]layers are (.+)$")
  if rest then out[#out + 1] = "You are " .. rest; out[#out + 1] = rest end
  rest = t:match("^[Pp]layers (.+)$")
  if rest then out[#out + 1] = rest end
  rest = t:match("^[Pp]layer (.+)$")
  if rest then out[#out + 1] = rest end
  return out
end
local function parsePlayerMod(text)
  if not tostring(text or ""):match("^[Pp]layer") then return nil end
  for _, v in ipairs(variants(text)) do
    local ok, mods, extra = pcall(modLib.parseMod, v)
    if ok and mods and #mods > 0 and not extra then return mods, v end
  end
  return nil
end
-- PoB's calculator reads the Configuration's mods each time it runs: add the map's for one run
local function withMods(modsList)
  local cfg = build.configTab
  local saved = cfg.modList
  local ml = new("ModList")
  ml:AddList(saved)
  for _, mods in ipairs(modsList) do for _, m in ipairs(mods) do ml:AddMod(modLib.setSource(m, "Map")) end end
  cfg.modList = ml
  local calcFunc = build.calcsTab:GetMiscCalculator()
  local ok, out = pcall(calcFunc, {})
  cfg.modList = saved
  if not ok then error(out) end
  return out
end
local function mapCheck(mods)
  local calcFunc = build.calcsTab:GetMiscCalculator()
  local base = calcFunc({}) -- the same calculation as with the mods, so the two compare
  local results, all = {}, {}
  for i, text in ipairs(mods or {}) do
    local parsed, as = parsePlayerMod(text)
    if parsed then
      local okc, out = pcall(withMods, { parsed })
      results[i] = okc and { text = text, as = as, after = pick(out) } or { text = text, as = as, error = tostring(out) }
      all[#all + 1] = parsed
    else
      results[i] = { text = text }
    end
  end
  local r = { ok = true, before = pick(base), results = results }
  if #all > 0 then local okc, out = pcall(withMods, all); if okc then r.all = pick(out) end end
  -- your main skill: its damage by type, whether it's a minion skill, leech and regeneration
  local o = build.calcsTab.mainOutput or {}
  local hand = o.MainHand or o
  local dmg = {}
  for _, t in ipairs({ "Physical", "Lightning", "Cold", "Fire", "Chaos" }) do
    local avg = num(hand[t .. "HitAverage"] or o[t .. "HitAverage"])
    local mn, mx = num(hand[t .. "Min"] or o[t .. "Min"]), num(hand[t .. "Max"] or o[t .. "Max"])
    if avg or mn or mx then dmg[t] = avg or ((mn or 0) + (mx or 0)) / 2 end
  end
  r.damage = dmg
  r.minion = (num(o.Minion and o.Minion.CombinedDPS) or 0) > 0 and not ((num(o.CombinedDPS) or 0) > (num(o.Minion.CombinedDPS) or 0))
  r.leech = num(o.LifeLeechGainRate) or num(o.LifeLeechRate) or num(o.LifeLeech)
  r.regen = num(o.LifeRegenRecovery)
  r.life = num(o.Life)
  return r
end

-- PoE1 loot filter: the affix names ("Virile", "of the Rainbow") of the higher tiers of trade stats,
-- for mods that can roll on an item with these tags (ring, amulet, belt, helmet, gloves...).
--   req: { ids = { "explicit.stat_3299347043", ... }, tags = { "ring" }, tiers = 3 } -> { [id] = { {affix, level, type}, ... } }
-- a skill or support gem you copied, at its level and quality, in place of the same gem in your build
-- (every group that uses it): what it changes. { name, level, quality } -> { before, hits = { {group, level, quality, after} } }
local function gemCheck(req)
  local want = tostring(req.name or ""):lower()
  -- the game calls supports "Impale Support"; Path of Building calls them "Impale"
  local wantShort = want:gsub("%s+support$", "")
  if want == "" then return { ok = false, error = "no gem" } end
  local calcFunc, base = build.calcsTab:GetMiscCalculator()
  local hits = {}
  for _, g in ipairs(build.skillsTab.socketGroupList or {}) do
    if g.enabled ~= false then
      for _, gem in ipairs(g.gemList or {}) do
        local ge = gem.grantedEffect or (gem.gemData and gem.gemData.grantedEffect)
        local nm = (gem.gemData and gem.gemData.name) or gem.nameSpec or (ge and ge.name)
        if nm and (tostring(nm):lower() == want or tostring(nm):lower() == wantShort) and gem.enabled ~= false then
          local oldL, oldQ = gem.level, gem.quality
          if req.level then gem.level = req.level end
          if req.quality then gem.quality = req.quality end
          local ok, after = pcall(calcFunc, {})
          gem.level, gem.quality = oldL, oldQ
          hits[#hits + 1] = { group = g.displayLabel or g.label, level = oldL, quality = oldQ, after = ok and pick(after) or nil, error = (not ok) and tostring(after) or nil }
        end
      end
    end
  end
  return { ok = true, before = pick(base), hits = hits }
end

-- anoint (PoE1) / instill (PoE2): every notable that can go on an amulet, tried in place of the amulet's
-- current one (as Path of Building's own anoint list does). Notables already on your tree are skipped.
--   { seconds = 40 } -> { before, now = { "Name" }, results = { {name, stats, recipe, after} }, checked, total }
local function anointCheck(req)
  local slot = build.itemsTab.slots["Amulet"]
  local cur = slot and slot.selItemId and build.itemsTab.items[slot.selItemId]
  -- no amulet in the build: a plain one, so the notables still compare
  local raw = cur and cur:BuildRaw() or "Rarity: NORMAL\nGold Amulet\n"
  if not cur then cur = makeItem(raw) end
  if not cur then return { ok = false, error = "Your build has no amulet." } end
  local function anointed(node)
    local item = makeItem(raw)
    if not item then return nil end
    local keep = {}
    for _, l in ipairs(item.enchantModLines or {}) do if not tostring(l.line or ""):match("^Allocates ") then keep[#keep + 1] = l end end
    item.enchantModLines = keep
    if node then table.insert(item.enchantModLines, 1, { enchant = true, line = "Allocates " .. node.dn }) end
    item:BuildAndParseRaw()
    return item
  end
  local now = {}
  for _, l in ipairs(cur.enchantModLines or {}) do local n = tostring(l.line or ""):match("^Allocates (.+)$"); if n then now[#now + 1] = n end end
  local calcFunc = build.calcsTab:GetMiscCalculator()
  local bare = anointed(nil)
  if not bare then return { ok = false, error = "Path of Building couldn't read your amulet." } end
  local okb, base = pcall(calcFunc, { repSlotName = "Amulet", repItem = bare })
  if not okb then return { ok = false, error = tostring(base) } end
  local list, checked, total = {}, 0, 0
  local deadline = os.clock() + (tonumber(req.seconds) or 40)
  local alloc = build.spec.allocNodes or {}
  for id, node in pairs(build.spec.tree.nodes or {}) do
    if node.recipe and #node.recipe >= 1 and node.dn and node.modKey ~= "" and not alloc[id] then
      total = total + 1
      if os.clock() < deadline then
        checked = checked + 1
        local item = anointed(node)
        local ok, o = false, nil
        if item then ok, o = pcall(calcFunc, { repSlotName = "Amulet", repItem = item }) end
        if ok then list[#list + 1] = { name = node.dn, stats = node.sd, recipe = node.recipe, after = pick(o) } end
      end
    end
  end
  return { ok = true, before = pick(base), now = now, results = list, checked = checked, total = total, noAmulet = not (slot and slot.selItemId and build.itemsTab.items[slot.selItemId]) }
end

-- PoE1 boss check: Path of Building's boss skill presets (Configuration → Boss Skill Preset) at the
-- Pinnacle and Uber tiers, one at a time: how many of each hit you can take. Your own configuration is
-- put back afterwards. { tiers = { "Pinnacle", "Uber" } } -> { before, skills = { {name, tier, hits, avgHits, damage} } }
local function bossCheck(req)
  local cfg = build.configTab
  if not (data.bossSkills and data.bossSkillsList and cfg.varControls and cfg.varControls.presetBossSkills) then return { ok = false, error = "this Path of Building has no boss presets" } end
  local set = cfg.configSets[cfg.activeConfigSetId]
  local input, ph = set.input, set.placeholder
  local savedIn, savedPh = copyTable(input), copyTable(ph)
  local function restore()
    wipeTable(input); for k, v in pairs(savedIn) do input[k] = v end
    wipeTable(ph); for k, v in pairs(savedPh) do ph[k] = v end
    local c = cfg.varControls
    if c.enemyIsBoss then c.enemyIsBoss:SelByValue(input.enemyIsBoss or cfg:GetDefaultState("enemyIsBoss"), "val") end
    if c.enemyDamageType then c.enemyDamageType:SelByValue(input.enemyDamageType or cfg:GetDefaultState("enemyDamageType"), "val"); c.enemyDamageType.enabled = true end
    cfg:BuildModList()
  end
  -- your own enemy damage numbers would override the preset's
  local clear = { "enemyDamageType", "enemySpeed", "enemyCritChance", "enemyPhysicalOverwhelm", "enemyLightningPen", "enemyColdPen", "enemyFirePen" }
  for _, t in ipairs({ "Physical", "Lightning", "Cold", "Fire", "Chaos" }) do clear[#clear + 1] = "enemy" .. t .. "Damage" end
  local skills = {}
  local okAll, err = pcall(function()
    for _, tier in ipairs(req.tiers or { "Pinnacle", "Uber" }) do
      for _, entry in ipairs(data.bossSkillsList) do
        local name = entry.val
        if name and name ~= "None" and data.bossSkills[name] then
          for _, k in ipairs(clear) do input[k] = nil end
          input.enemyIsBoss = tier
          cfg.varControls.enemyIsBoss:SelByValue(tier, "val")
          input.presetBossSkills = name
          cfg:BuildModList()
          local calcFunc = build.calcsTab:GetMiscCalculator()
          local ok, o = pcall(calcFunc, {}, false)
          if ok and o then
            local dmg = 0
            for _, t in ipairs({ "Physical", "Lightning", "Cold", "Fire", "Chaos" }) do dmg = dmg + (num(ph["enemy" .. t .. "Damage"]) or 0) end
            skills[#skills + 1] = { name = name, tier = tier, hits = num(o.NumberOfMitigatedDamagingHits), avgHits = num(o.TotalNumberOfHits), damage = dmg > 0 and dmg or nil, damageType = data.bossSkills[name].DamageType }
          else
            skills[#skills + 1] = { name = name, tier = tier, error = tostring(o) }
          end
        end
      end
    end
  end)
  restore()
  if not okAll then return { ok = false, error = tostring(err) } end
  return { ok = true, skills = skills }
end

local function affixNames(req)
  local want = {}
  for _, id in ipairs(req.ids or {}) do local h = tostring(id):match("stat_(%d+)$"); if h then want[tonumber(h)] = id end end
  local tags = {}
  for _, t in ipairs(req.tags or {}) do tags[t] = true end
  local function spawns(mod)
    for i, k in ipairs(mod.weightKey or {}) do
      if tags[k] or k == "default" then return (mod.weightVal and mod.weightVal[i] or 0) > 0 end
    end
    return false
  end
  local found = {}
  for _, mod in pairs((data.itemMods and data.itemMods.Item) or {}) do
    if (mod.type == "Prefix" or mod.type == "Suffix") and mod.affix and mod.tradeHashes and spawns(mod) then
      for hash in pairs(mod.tradeHashes) do
        local id = want[tonumber(hash)]
        if id then found[id] = found[id] or {}; table.insert(found[id], { affix = mod.affix, level = mod.level or 0, type = mod.type }) end
      end
    end
  end
  local tiers = tonumber(req.tiers) or 3
  local out = {}
  for id, list in pairs(found) do
    table.sort(list, function(a, b) return a.level > b.level end)
    local seen, top = {}, {}
    for _, m in ipairs(list) do
      if not seen[m.affix] then seen[m.affix] = true; top[#top + 1] = m end
      if #top >= tiers then break end
    end
    out[id] = top
  end
  return { ok = true, affixes = out }
end

-- Path of Building's own trade search generator ("Trader"): it tries every mod that can roll on
-- the slot's item type on your build and weights each by how much it raises your damage and
-- effective HP, then builds a weighted trade search from that.
--   req: { slot = "Gloves", weights = { {stat="MinionCombinedDPS", weightMult=0.6}, ... }, maxPrice, maxPriceType }
local function genQuery(req)
  local slot = build.itemsTab.slots[pobSlot(req.slot)]
  if not slot then return { ok = false, error = "unknown slot " .. tostring(req.slot) } end
  -- PoB2 takes the arguments in new(); PoB1 wants them in the constructor call
  local okg, gen = pcall(new, "TradeQueryGenerator", { itemsTab = build.itemsTab })
  if not okg then gen = new("TradeQueryGenerator"):TradeQueryGenerator({ itemsTab = build.itemsTab }) end
  local result, err
  gen.requesterCallback = function(_, q, e) result = q; err = e end
  gen.requesterContext = {}
  local weights = {}
  for _, w in ipairs(req.weights or {}) do weights[#weights + 1] = { stat = w.stat, weightMult = w.weightMult, label = w.stat } end
  if #weights == 0 then weights = { { stat = "FullDPS", weightMult = 1.0 }, { stat = "TotalEHP", weightMult = 0.5 } } end
  local options = {
    statWeights = weights, includeCorrupted = req.includeCorrupted ~= false, includeMirrored = false, includeRunes = false,
    -- PoE1 only (PoB2 ignores them)
    includeEldritch = req.includeEldritch or "None", includeScourge = req.includeScourge, includeTalisman = req.includeTalisman,
    influence1 = req.influence1 or 1, influence2 = req.influence2 or 1, -- 1: no influence
    maxPrice = req.maxPrice, maxPriceType = req.maxPriceType, jewelType = req.jewelType or "Base",
  }
  local t0 = os.clock()
  gen:StartQuery(slot, options)
  local frames = 0
  while gen.calcContext and gen.calcContext.co and frames < 1000000 do gen:OnFrame(); frames = frames + 1 end
  if not result then return { ok = false, error = err or "Path of Building could not build a search for this slot" } end
  -- the per-mod weights it found, for showing and for trimming the search to the site's limits
  local mw = {}
  for i, e in ipairs(gen.modWeights or {}) do
    if i > 60 then break end
    mw[#mw + 1] = { id = e.tradeModId, weight = e.weight, invert = e.invert or nil, mean = e.meanStatDiff }
  end
  return { ok = true, query = result, error = err, modWeights = mw, seconds = os.clock() - t0 }
end

reply(enc({ ready = true, version = pobVersion() }))

while true do
  local line = io.read("*l")
  if not line then break end
  local req = dkjson.decode(line)
  local id = req and req.id
  local ok, res = pcall(function()
    if req.cmd == "load" then
      local xml = tostring(req.xml or "")
      local root = GAME == "poe1" and "PathOfBuilding" or "PathOfBuilding2"
      if not xml:match("^%s*<%?xml[^>]*>%s*<" .. root .. "[%s>]") and not xml:match("^%s*<" .. root .. "[%s>]") then
        if GAME == "poe2" and xml:match("<PathOfBuilding[%s>]") then return { ok = false, wrongGame = "poe1", error = "That's a Path of Building build for Path of Exile 1. Export it from Path of Building 2 (PoE2) instead." } end
        if GAME == "poe1" and xml:match("<PathOfBuilding2[%s>]") then return { ok = false, wrongGame = "poe2", error = "That's a Path of Building 2 build (Path of Exile 2). Export it from Path of Building Community (PoE1) instead." } end
        return { ok = false, error = GAME == "poe1" and "That isn't a Path of Building build." or "That isn't a Path of Building 2 build." }
      end
      -- PoB's XML reader quietly accepts a cut-off export as an empty character
      if not xml:match("</" .. root .. ">%s*$") then return { ok = false, error = "That build looks cut off (the export code wasn't copied whole). Copy it again from Path of Building." } end
      -- PoE1: only the newest passive trees come with the app; a build on an older one is moved to
      -- the newest (as Path of Building's own "convert to latest" does)
      local converted, newer, timeless
      if GAME == "poe1" and latestTreeVersion then
        local function ver(v) local a, b = tostring(v):match("^(%d+)_(%d+)"); return (tonumber(a) or 0) * 1000 + (tonumber(b) or 0) end
        xml = xml:gsub('treeVersion="([%w_]+)"', function(v)
          local f = io.open("TreeData/" .. v .. "/tree.lua", "r")
          if f then f:close(); return nil end
          converted = converted or v
          if ver(v) > ver(latestTreeVersion) then newer = true end
          return 'treeVersion="' .. latestTreeVersion .. '"'
        end)
        -- timeless jewels need lookup tables that don't come with the app (hundreds of MB):
        -- take them out of their sockets so the rest of the build still loads
        local ids = {}
        for id, body in xml:gmatch('<Item%s[^>]-id="(%d+)"[^>]*>(.-)</Item>') do
          if body:match("\nTimeless Jewel%s*\n") or body:match("\nTimeless Jewel%s*$") then ids[id] = true end
        end
        if next(ids) then
          xml = xml:gsub("<Socket [^>]*>", function(tag)
            local id = tag:match('itemId="(%d+)"')
            if id and ids[id] then timeless = (timeless or 0) + 1; return (tag:gsub('itemId="%d+"', 'itemId="0"')) end
            return nil
          end)
        end
      end
      if mainObject then mainObject.promptMsg = nil end
      loadBuildFromXML(xml, req.name or "build")
      local msg = mainObject and mainObject.promptMsg
      if msg then
        mainObject.promptMsg = nil
        -- just PoB's error, without its "Press Enter/Escape…" help and version lines
        msg = tostring(msg):gsub("%^%d", ""):gsub("%^x%x%x%x%x%x%x", ""):gsub("\n[^\n]*Press [^\n]*", ""):gsub("\nv%d[%w%.%-]*", ""):gsub("^%s*Error:%s*", ""):gsub("%s+$", "")
        return { ok = false, error = "Path of Building couldn't load this build: " .. msg }
      end
      if not (build and build.spec and build.calcsTab and build.calcsTab.mainOutput) then return { ok = false, error = "Path of Building couldn't load this build." } end
      local r = summary()
      if converted then r.treeConverted = { from = converted, to = latestTreeVersion, newer = newer or nil } end
      if timeless then r.timelessRemoved = timeless end
      return r
    elseif req.cmd == "equip" then
      local done = equip(req.items)
      local r = summary(); r.equipped = done
      return r
    elseif req.cmd == "query" then
      return genQuery(req)
    elseif req.cmd == "summary" then
      return summary()
    elseif req.cmd == "bosscheck" then
      return bossCheck(req)
    elseif req.cmd == "anoints" then
      return anointCheck(req)
    elseif req.cmd == "gemcheck" then
      return gemCheck(req)
    elseif req.cmd == "affixes" then
      return affixNames(req)
    elseif req.cmd == "mapcheck" then
      return mapCheck(req.mods or {})
    elseif req.cmd == "pairs" then
      return { ok = true, results = evalPairs(req.pairs or {}) }
    elseif req.cmd == "eval" then
      return { ok = true, results = evalItems(req.items or {}) }
    elseif req.cmd == "sheet" then
      return sheet()
    elseif req.cmd == "quit" then
      os.exit(0)
    end
    return { ok = false, error = "unknown command" }
  end)
  if not ok then res = { ok = false, error = tostring(res) } end
  res.id = id
  reply(enc(res))
end
