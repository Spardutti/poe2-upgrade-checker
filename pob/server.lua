-- PoE2 Upgrade Checker <-> Path of Building bridge.
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

-- PoB waits for Enter when it can't start; we're not a console, so don't let it block
local rawRead = io.read
local starting = true
io.read = function(...) if starting then return nil end; return rawRead(...) end
dofile("HeadlessWrapper.lua")
starting = false
io.read = rawRead
local dkjson = require("dkjson")
if not build or (__mainObject__ and __mainObject__.promptMsg) then
  local msg = tostring(__mainObject__ and __mainObject__.promptMsg or table.concat(recent, "\n"))
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
    MinionDPS = num(m.CombinedDPS) or num(m.TotalDPS), MinionLife = num(m.Life), MinionES = num(m.EnergyShield),
    Life = num(o.Life), EnergyShield = num(o.EnergyShield), Mana = num(o.Mana), Ward = num(o.Ward),
    TotalEHP = num(o.TotalEHP), Armour = num(o.Armour), Evasion = num(o.Evasion),
    Spirit = num(o.Spirit), SpiritUnreserved = num(o.SpiritUnreserved), ManaUnreserved = num(o.ManaUnreserved),
    Str = num(o.Str), Dex = num(o.Dex), Int = num(o.Int),
    ReqStr = num(o.ReqStr), ReqDex = num(o.ReqDex), ReqInt = num(o.ReqInt),
    MovementSpeedMod = num(o.MovementSpeedMod),
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
local function makeItem(text)
  local ok, item = pcall(new, "Item", text)
  if ok and item and item.base then return item end
  local ok2, item2 = pcall(function() return new("Item"):Item(text) end)
  if ok2 and item2 and item2.base then return item2 end
  return nil
end

local SLOTS = { "Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt" }
local function gearNames()
  local g = {}
  for _, name in ipairs(SLOTS) do
    local slot = build.itemsTab.slots[name]
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
    local slot = build.itemsTab.slots[e.slot]
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
        list[#list + 1] = { slot = sock.slotName, nodeId = nodeId, label = "Socket #" .. n, jewel = jewel and (jewel.title or jewel.name) or nil }
      end
    end
  end
  return list
end

local function summary()
  local o = build.calcsTab.mainOutput
  local skill = build.mainSocketGroup and build.skillsTab.socketGroupList[build.mainSocketGroup]
  return {
    ok = true,
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
    if type(v) == "boolean" then r[k] = v else r[k] = num(v) end
  end
  return r
end
local PLAYER_KEYS = {
  "FullDPS", "TotalDPS", "CombinedDPS", "TotalDotDPS", "AverageHit", "Speed", "CritChance", "CritMultiplier", "HitChance", "Accuracy",
  "Life", "LifeUnreserved", "LifeRegenRecovery", "EnergyShield", "EnergyShieldRecharge", "EnergyShieldRechargeDelay", "EnergyShieldRegenRecovery",
  "Mana", "ManaUnreserved", "ManaRegenRecovery", "Ward", "WardRechargeDelay",
  "Spirit", "SpiritReserved", "SpiritUnreserved",
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
      if not item then return { ok = false, error = "Path of Building couldn't read this item" } end
      local slot = it.slot
      if slot == "Jewel" then
        -- try it in every allocated socket: replacing the jewel there, or in an empty one
        local multi = {}
        for _, s in ipairs(jewelSockets()) do
          if build.itemsTab:IsItemValidForSlot(item, s.slot) then
            local new_ = calcFunc({ repSlotName = s.slot, repItem = item })
            multi[#multi + 1] = { slot = s.slot, label = s.label, replacing = s.jewel, after = pick(new_) }
          end
        end
        if #multi == 0 then return { ok = false, error = "You have no allocated jewel socket this jewel fits" } end
        return { ok = true, slot = slot, before = pick(base), multi = multi }
      end
      local new_ = calcFunc({ repSlotName = slot, repItem = item })
      return { ok = true, slot = slot, before = pick(base), after = pick(new_) }
    end)
    res[i] = ok and r or { ok = false, error = tostring(r) }
  end
  return res
end

-- Path of Building's own trade search generator ("Trader"): it tries every mod that can roll on
-- the slot's item type on your build and weights each by how much it raises your damage and
-- effective HP, then builds a weighted trade search from that.
--   req: { slot = "Gloves", weights = { {stat="MinionCombinedDPS", weightMult=0.6}, ... }, maxPrice, maxPriceType }
local function genQuery(req)
  local slot = build.itemsTab.slots[req.slot]
  if not slot then return { ok = false, error = "unknown slot " .. tostring(req.slot) } end
  local gen = new("TradeQueryGenerator", { itemsTab = build.itemsTab })
  local result, err
  gen.requesterCallback = function(_, q, e) result = q; err = e end
  gen.requesterContext = {}
  local weights = {}
  for _, w in ipairs(req.weights or {}) do weights[#weights + 1] = { stat = w.stat, weightMult = w.weightMult, label = w.stat } end
  if #weights == 0 then weights = { { stat = "FullDPS", weightMult = 1.0 }, { stat = "TotalEHP", weightMult = 0.5 } } end
  local options = {
    statWeights = weights, includeCorrupted = req.includeCorrupted ~= false, includeMirrored = false, includeRunes = false,
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

reply(enc({ ready = true, version = launch and launch.versionNumber or nil }))

while true do
  local line = io.read("*l")
  if not line then break end
  local req = dkjson.decode(line)
  local id = req and req.id
  local ok, res = pcall(function()
    if req.cmd == "load" then
      loadBuildFromXML(req.xml, req.name or "build")
      return summary()
    elseif req.cmd == "equip" then
      local done = equip(req.items)
      local r = summary(); r.equipped = done
      return r
    elseif req.cmd == "query" then
      return genQuery(req)
    elseif req.cmd == "summary" then
      return summary()
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
