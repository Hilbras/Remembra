-- Minimal Redis shim: only the commands the Remembra quota scripts use.
-- Exists for scripts/verify-redis-lua.mjs. Fidelity points that matter to the
-- quota and lock scripts are noted at each command below.
-- Fidelity notes that matter for these scripts:
--   * ZADD overwrites an existing (score, member) pair, so members must be unique.
--   * ZREMRANGEBYSCORE is inclusive of both bounds.
--   * ZCOUNT is exclusive of the min bound, inclusive of the max bound.
--   * A key with no expiry must not silently acquire one.

-- Global so the JS harness can inspect and seed it between scenarios.
store = {}
-- Expiries live apart from the value, because PEXPIRE applies to any key type,
-- not just sorted sets.
ttls = {}

local function to_number(v)
  if type(v) == "number" then return v end
  local n = tonumber(v)
  if n == nil then error("value is not numeric: " .. tostring(v)) end
  return n
end

local function zset(key)
  local e = store[key]
  if e == nil then e = { entries = {} }; store[key] = e end
  return e
end

local function sort_entries(e)
  table.sort(e.entries, function(a, b)
    if a.score == b.score then return a.member < b.member end
    return a.score < b.score
  end)
end

redis = {}

function redis.call(cmd, ...)
  if cmd == "ZADD" then
    local key = select(1, ...)
    local score = to_number(select(2, ...))
    local member = select(3, ...)
    local e = zset(key)
    for _, entry in ipairs(e.entries) do
      if entry.member == member then
        entry.score = score
        sort_entries(e)
        return 1
      end
    end
    table.insert(e.entries, { score = score, member = member })
    sort_entries(e)
    return 1
  elseif cmd == "ZCARD" then
    return #zset(select(1, ...)).entries
  elseif cmd == "ZREMRANGEBYSCORE" then
    local lo = to_number(select(2, ...))
    local hi = to_number(select(3, ...))
    local e = zset(select(1, ...))
    local kept = {}
    for _, entry in ipairs(e.entries) do
      if not (entry.score >= lo and entry.score <= hi) then
        table.insert(kept, entry)
      end
    end
    e.entries = kept
    return #kept
  elseif cmd == "ZRANGE" then
    local key = select(1, ...)
    local first = to_number(select(2, ...))
    local stop = to_number(select(3, ...))
    local withscores = select(4, ...)
    local e = zset(key)
    local n = #e.entries
    local last = stop < 0 and (n + stop + 1) or math.min(stop + 1, n)
    local out = {}
    for i = first + 1, last do
      local entry = e.entries[i]
      if entry then
        table.insert(out, entry.member)
        if withscores == "WITHSCORES" then table.insert(out, entry.score) end
      end
    end
    return out
  elseif cmd == "ZCOUNT" then
    local lo = to_number(select(2, ...))
    local hi = select(3, ...)
    if hi == "+inf" then hi = math.huge end
    local n = 0
    for _, entry in ipairs(zset(select(1, ...)).entries) do
      if entry.score > lo and entry.score <= hi then n = n + 1 end
    end
    return n
  elseif cmd == "PEXPIRE" then
    local key = select(1, ...)
    local ttl = to_number(select(2, ...))
    if ttl <= 0 then
      store[key] = nil
      ttls[key] = nil
      return 1
    end
    ttls[key] = ttl
    return 1
  elseif cmd == "GET" then
    local v = store[select(1, ...)]
    if type(v) == "string" then return v end
    return false
  elseif cmd == "DEL" then
    if store[select(1, ...)] ~= nil then
      store[select(1, ...)] = nil
      ttls[select(1, ...)] = nil
      return 1
    end
    return 0
  end
  error("unsupported command in shim: " .. tostring(cmd))
end

-- Run a script body the way Redis does: KEYS and ARGV are globals, the body's
-- return value is the reply.
function run_script(body)
  local chunk = assert(load(body, "=remembra-script"))
  local reply = chunk()
  -- The quota scripts reply with a table; release and renew reply with a number.
  if type(reply) ~= "table" then
    return tostring(reply)
  end
  local parts = {}
  for i = 1, #reply do
    parts[#parts + 1] = tostring(reply[i])
  end
  return table.concat(parts, ",")
end

function reset()
  store = {}
  ttls = {}
end
