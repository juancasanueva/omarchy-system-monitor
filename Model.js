.pragma library

// Pure helpers for the System Monitor widget: kernel text parsers, the usage
// arithmetic between two samples, and the formatters. Everything here is plain
// data in, plain data out, so the whole file is unit tested with node
// (tests/test_model.cjs) without a running shell.
//
// Sources, all kernel-generated:
//   /proc/stat        CPU ticks, aggregate and per core
//   /proc/cpuinfo     CPU model name
//   /proc/meminfo     memory breakdown
//   /proc/diskstats   sectors read and written per block device
//   /proc/net/dev     bytes received and sent per interface
//   /sys/block/zram0/mm_stat           compressed swap held in RAM
//   /sys/devices/cpu_{core,atom}/cpus  Intel hybrid P/E core topology
//   /sys/class/hwmon/hwmon*/temp1_input  CPU package temperature
//   /sys/class/drm/card*/device/       amdgpu load and memory, plus its hwmon
//   /usr/share/hwdata/pci.ids          GPU name when amdgpu has no product_name
// Disk capacity comes from `df` (see Panel.qml) because statvfs has no procfs file.
// Colours come from the current Omarchy theme's colors.toml.

// --- Theme -----------------------------------------------------------------

var THEME_MAX = 65536

// The six ANSI hues a theme defines, by name or by terminal slot.
var ANSI = {
  red: "color1", green: "color2", yellow: "color3",
  blue: "color4", magenta: "color5", cyan: "color6"
}

// Base ANSI colours of an Omarchy colors.toml as "#rrggbb" strings. Named keys
// win over numbered ones; bright variants are ignored.
function parseThemeColors(text) {
  var named = Object.create(null)
  var numbered = Object.create(null)
  if (text === undefined || text === null) return named
  var s = String(text)
  if (s.length > THEME_MAX) return named
  var rows = s.split("\n")
  for (var i = 0; i < rows.length; i++) {
    var m = /^\s*([a-z0-9_]{1,24})\s*=\s*["']?(#[0-9A-Fa-f]{6})\b/.exec(rows[i])
    if (m) (/^color\d/.test(m[1]) ? numbered : named)[m[1]] = m[2]
  }
  var out = Object.create(null)
  for (var hue in ANSI) {
    var value = named[hue] || numbered[ANSI[hue]]
    if (value) out[hue] = value
  }
  return out
}

// Colour roles of the macOS app (Presentation/Theme/Palette.swift), assigned
// from the theme. `shell` holds the shell's own roles: foreground, background,
// accent, urgent, muted, popupBackground, popupText. A theme without ANSI
// colours falls back to the accent (and urgent for Wired).
function themePalette(colors, shell) {
  function hue(name, fallback) { return colors[name] || fallback }
  var blue = hue("blue", shell.accent)
  var green = hue("green", shell.accent)
  var magenta = hue("magenta", shell.accent)
  return {
    panelBackground: shell.popupBackground,
    textPrimary: shell.popupText,
    cpuAccent: blue,
    cpuEfficiency: hue("cyan", shell.accent),
    gpuAccent: hue("cyan", shell.accent),
    memAccent: hue("yellow", shell.accent),
    memWired: hue("red", shell.urgent),
    memCompressed: magenta,
    memCached: blue,
    memFree: green,
    diskAccent: green,
    networkAccent: magenta,
    networkDownload: green,
    networkUpload: blue
  }
}

// Nerd Font glyphs standing in for the SF Symbols of the macOS app.
var glyphs = {
  cpu: String.fromCodePoint(0xF061A),       // md-chip
  gpu: String.fromCodePoint(0xF08AE),       // md-expansion_card
  memory: String.fromCodePoint(0xF035B),    // md-memory
  disk: String.fromCodePoint(0xF02CA),      // md-harddisk
  network: String.fromCodePoint(0xF059F),   // md-web
  read: String.fromCodePoint(0xF0965),      // md-file_download
  write: String.fromCodePoint(0xF0A4D),     // md-file_upload
  download: String.fromCodePoint(0xF0047),  // md-arrow_down_bold_circle
  upload: String.fromCodePoint(0xF005F),    // md-arrow_up_bold_circle
  activity: String.fromCodePoint(0xF0128)   // md-chart_line
}

var BAR_SAMPLES = 60
var GRAPH_SAMPLES = 120
var CORES_PER_ROW = 8
var NETWORK_GRAPH_FLOOR = 10000
var UNAVAILABLE = "—"

// Bounds on kernel text, so a surprising file can never grow the shell's work.
var MAX_TEXT = 1 << 20
var MAX_CORES = 512
var MAX_LINES = 4096

function lines(text) {
  if (text === undefined || text === null) return []
  var s = String(text)
  if (s.length > MAX_TEXT) return []
  return s.split("\n").slice(0, MAX_LINES)
}

function toCount(value) {
  var n = Number(value)
  return isFinite(n) && n >= 0 ? n : NaN
}

function clamp01(value) {
  var n = Number(value)
  if (!isFinite(n) || n < 0) return 0
  return n > 1 ? 1 : n
}

// --- CPU -------------------------------------------------------------------

// One /proc/stat cpu line as tick buckets. Guest time is already part of user
// time, so only the first eight fields are summed.
function cpuTicks(fields) {
  var v = []
  for (var i = 0; i < 8; i++) {
    var n = toCount(fields[i] === undefined ? 0 : fields[i])
    if (isNaN(n)) return null
    v.push(n)
  }
  var idle = v[3] + v[4]
  var all = 0
  for (var j = 0; j < 8; j++) all += v[j]
  return { user: v[0] + v[1], system: v[2] + v[5] + v[6], idle: idle, all: all }
}

function parseCpuStat(text) {
  var total = null
  var cores = []
  var rows = lines(text)
  for (var i = 0; i < rows.length; i++) {
    var parts = rows[i].trim().split(/\s+/)
    var name = parts[0]
    if (name === "cpu") {
      total = cpuTicks(parts.slice(1))
    } else if (/^cpu\d{1,4}$/.test(name) && cores.length < MAX_CORES) {
      var ticks = cpuTicks(parts.slice(1))
      if (ticks) {
        ticks.index = Number(name.slice(3))
        cores.push(ticks)
      }
    }
  }
  return total ? { total: total, cores: cores } : null
}

function delta(a, b) {
  var d = b - a
  return d > 0 ? d : 0
}

function busyFraction(prev, cur) {
  var all = delta(prev.all, cur.all)
  if (all <= 0) return 0
  return clamp01((all - delta(prev.idle, cur.idle)) / all)
}

function average(values) {
  if (values.length === 0) return null
  var sum = 0
  for (var i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}

// Usage between two parsed samples. `topology` is null on a non-hybrid CPU,
// otherwise { performance: [cpu indices], efficiency: [cpu indices] }.
function cpuUsage(prev, cur, topology) {
  if (!prev || !cur) return null
  var all = delta(prev.total.all, cur.total.all)
  var usage = {
    total: busyFraction(prev.total, cur.total),
    user: all > 0 ? clamp01(delta(prev.total.user, cur.total.user) / all) : 0,
    system: all > 0 ? clamp01(delta(prev.total.system, cur.total.system) / all) : 0,
    performanceAverage: null,
    efficiencyAverage: null,
    cores: []
  }

  var previous = {}
  for (var i = 0; i < prev.cores.length; i++) previous[prev.cores[i].index] = prev.cores[i]

  var perf = []
  var eff = []
  for (var j = 0; j < cur.cores.length; j++) {
    var core = cur.cores[j]
    var before = previous[core.index]
    var value = before ? busyFraction(before, core) : 0
    var level = "unknown"
    if (topology && topology.performance.indexOf(core.index) >= 0) level = "performance"
    else if (topology && topology.efficiency.indexOf(core.index) >= 0) level = "efficiency"
    if (level === "performance") perf.push(value)
    if (level === "efficiency") eff.push(value)
    usage.cores.push({ index: core.index, usage: value, level: level })
  }
  usage.performanceAverage = average(perf)
  usage.efficiencyAverage = average(eff)
  return usage
}

// The first "model name" of /proc/cpuinfo, without trademarks, clock speed,
// core count or the integrated graphics. Empty where the kernel reports none,
// as on most ARM boards.
function cpuName(text) {
  var rows = lines(text)
  for (var i = 0; i < rows.length; i++) {
    var m = /^model name\s*:\s*(.{1,200})$/.exec(rows[i])
    if (!m) continue
    return m[1]
      .replace(/\((R|TM)\)/gi, "")
      .replace(/\s+(w\/|with)\s+Radeon.*$/i, "")
      .replace(/\s*@.*$/, "")
      .replace(/\s+\d{1,3}-Core Processor.*$/i, "")
      .replace(/\s+CPU\b/, "")
      .replace(/\s+/g, " ")
      .trim()
  }
  return ""
}

// Kernel CPU list such as "0-7,16-19".
function parseCpuList(text) {
  var out = []
  var s = text === undefined || text === null ? "" : String(text).trim()
  if (s === "" || s.length > 4096) return out
  var parts = s.split(",")
  for (var i = 0; i < parts.length; i++) {
    var m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(parts[i].trim())
    if (!m) return []
    var from = Number(m[1])
    var to = m[2] === undefined ? from : Number(m[2])
    if (to < from || to >= MAX_CORES) return []
    for (var n = from; n <= to; n++) out.push(n)
  }
  return out
}

// Core bar groups, as CPUCardModel.groups: P-Cores and E-Cores on a hybrid
// CPU, otherwise one "Cores" group.
function coreGroups(cores, pal) {
  if (!cores || cores.length === 0) return []
  var perf = []
  var eff = []
  for (var i = 0; i < cores.length; i++) {
    if (cores[i].level === "performance") perf.push(cores[i])
    else if (cores[i].level === "efficiency") eff.push(cores[i])
  }
  if (perf.length === 0 && eff.length === 0) {
    return [{ title: "Cores", cores: cores, color: pal.cpuAccent }]
  }
  var groups = []
  if (perf.length > 0) groups.push({ title: "P-Cores", cores: perf, color: pal.cpuAccent })
  if (eff.length > 0) groups.push({ title: "E-Cores", cores: eff, color: pal.cpuEfficiency })
  return groups
}

function chunk(items, size) {
  var rows = []
  for (var i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

// hwmon drivers that report the CPU package: AMD (k10temp, zenpower), Intel
// (coretemp) and ARM SoCs (cpu_thermal). Their temp1 is Tctl or the package.
var CPU_SENSORS = ["k10temp", "zenpower", "coretemp", "cpu_thermal"]
var MAX_HWMON = 32

function isCpuSensor(name) {
  if (name === undefined || name === null) return false
  return CPU_SENSORS.indexOf(String(name).trim()) >= 0
}

// hwmon temp*_input is millidegrees Celsius. Readings outside what a sensor
// can physically report are treated as missing.
function parseTemperature(text) {
  if (text === undefined || text === null) return null
  var m = /^\s*(-?\d{1,7})\s*$/.exec(String(text))
  if (!m) return null
  var celsius = Number(m[1]) / 1000
  return celsius > -50 && celsius < 200 ? celsius : null
}

function cpuRows(usage, dp, pal, celsius) {
  var rows = [
    { key: "User", value: percent1(usage ? usage.user : 0, dp), color: pal.textPrimary },
    { key: "System", value: percent1(usage ? usage.system : 0, dp), color: pal.textPrimary }
  ]
  if (usage && usage.performanceAverage !== null) {
    rows.push({ key: "P-Cores", value: percent1(usage.performanceAverage, dp), color: pal.cpuAccent })
  }
  if (usage && usage.efficiencyAverage !== null) {
    rows.push({ key: "E-Cores", value: percent1(usage.efficiencyAverage, dp), color: pal.cpuEfficiency })
  }
  if (typeof celsius === "number" && isFinite(celsius)) {
    rows.push({ key: "Temperature", value: temperature(celsius, dp), color: pal.textPrimary })
  }
  return rows
}

// --- GPU -------------------------------------------------------------------

var MAX_GPU_CARDS = 8

// The files gpuSnapshot reads: [role, "device" or "hwmon", file name].
var GPU_FILES = [
  ["busy", "device", "gpu_busy_percent"],
  ["memBusy", "device", "mem_busy_percent"],
  ["vramUsed", "device", "mem_info_vram_used"],
  ["vramTotal", "device", "mem_info_vram_total"],
  ["gttUsed", "device", "mem_info_gtt_used"],
  ["gttTotal", "device", "mem_info_gtt_total"],
  ["temp", "hwmon", "temp1_input"],
  ["powerAverage", "hwmon", "power1_average"],
  ["powerInput", "hwmon", "power1_input"],
  ["sclk", "hwmon", "freq1_input"],
  ["mclk", "hwmon", "freq2_input"],
  ["vddgfx", "hwmon", "in0_input"]
]

// One whole number from a sysfs file, or null when the file is missing or
// holds anything else.
function parseInteger(text) {
  if (text === undefined || text === null) return null
  var m = /^\s*(-?\d{1,20})\s*$/.exec(String(text))
  return m ? Number(m[1]) : null
}

function positive(value) {
  return value !== null && value > 0 ? value : null
}

// The raw text of the amdgpu files, keyed by role: device/gpu_busy_percent,
// mem_busy_percent and mem_info_{vram,gtt}_{used,total}, then the card's hwmon
// temp1 (edge, millidegrees), power1_average or power1_input (microwatts),
// freq1/freq2 (sclk/mclk, Hz) and in0 (vddgfx, mV). Null without a busy
// reading, which means the card is not an amdgpu GPU.
function gpuSnapshot(files) {
  var busy = parseInteger(files.busy)
  if (busy === null) return null
  var memBusy = parseInteger(files.memBusy)
  var power = positive(parseInteger(files.powerAverage))
  if (power === null) power = positive(parseInteger(files.powerInput))
  var sclk = positive(parseInteger(files.sclk))
  var mclk = positive(parseInteger(files.mclk))
  return {
    busy: clamp01(busy / 100),
    memBusy: memBusy === null ? null : clamp01(memBusy / 100),
    vramUsed: parseInteger(files.vramUsed),
    vramTotal: positive(parseInteger(files.vramTotal)),
    gttUsed: parseInteger(files.gttUsed),
    gttTotal: positive(parseInteger(files.gttTotal)),
    temperature: parseTemperature(files.temp),
    watts: power === null ? null : power / 1e6,
    coreMhz: sclk === null ? null : Math.round(sclk / 1e6),
    memoryMhz: mclk === null ? null : Math.round(mclk / 1e6),
    vddgfx: positive(parseInteger(files.vddgfx))
  }
}

// pci.ids is about 1.6 MB; anything far past that is not the hwdata file.
var MAX_PCI_IDS = 8 << 20

function pciId(text) {
  var m = /^\s*0x([0-9a-fA-F]{4})\s*$/.exec(text === undefined || text === null ? "" : String(text))
  return m ? m[1].toLowerCase() : null
}

// Device name from pci.ids: vendors start a line, their devices follow on
// tab-indented lines. "Krackan [Radeon 840M / 860M Graphics]" becomes the
// marketing name inside the brackets.
function pciDeviceName(text, vendorText, deviceText) {
  var vendor = pciId(vendorText)
  var device = pciId(deviceText)
  if (!vendor || !device || text === undefined || text === null) return ""
  var s = String(text)
  if (s.length > MAX_PCI_IDS) return ""
  var start = s.indexOf("\n" + vendor + "  ")
  if (start < 0) return ""
  var end = s.slice(start + 1).search(/\n[0-9a-fA-F]/)
  var block = end < 0 ? s.slice(start) : s.slice(start, start + 1 + end)
  var m = new RegExp("\n\t" + device + "  ([^\n]{1,200})").exec(block)
  if (!m) return ""
  var bracket = /\[([^\]]+)\]\s*$/.exec(m[1])
  return (bracket ? bracket[1] : m[1]).trim()
}

function gpuName(productName, pciIds, vendorText, deviceText) {
  var own = productName === undefined || productName === null ? "" : String(productName).trim()
  if (own !== "" && own.length <= 200) return own
  return pciDeviceName(pciIds, vendorText, deviceText)
}

function usedOfTotal(used, total, dp) {
  return memoryBytes(used || 0, dp) + " / " + memoryBytes(total, dp)
}

// VRAM and shared system memory (GTT), each with a usage bar.
function gpuMemory(g, dp, pal) {
  if (!g) return []
  var out = []
  if (g.vramTotal !== null) {
    out.push({ key: "VRAM", value: usedOfTotal(g.vramUsed, g.vramTotal, dp), fraction: clamp01(g.vramUsed / g.vramTotal), color: pal.gpuAccent })
  }
  if (g.gttTotal !== null) {
    out.push({ key: "Shared", value: usedOfTotal(g.gttUsed, g.gttTotal, dp), fraction: clamp01(g.gttUsed / g.gttTotal), color: pal.gpuAccent })
  }
  return out
}

// Rows beside the ring for the readings this GPU reports; an APU, for one, has
// no memory clock.
function gpuRows(g, dp, pal) {
  if (!g) return []
  var rows = []
  if (g.memBusy !== null) rows.push({ key: "Memory busy", value: percent1(g.memBusy, dp) })
  if (g.temperature !== null) rows.push({ key: "Temperature", value: temperature(g.temperature, dp) })
  if (g.watts !== null) rows.push({ key: "Power", value: decimal(g.watts, 1, dp) + " W" })
  if (g.coreMhz !== null) rows.push({ key: "Core clock", value: g.coreMhz + " MHz" })
  if (g.memoryMhz !== null) rows.push({ key: "Memory clock", value: g.memoryMhz + " MHz" })
  if (g.vddgfx !== null) rows.push({ key: "Voltage", value: g.vddgfx + " mV" })
  for (var i = 0; i < rows.length; i++) rows[i].color = pal.textPrimary
  return rows
}

// --- Memory ----------------------------------------------------------------

// meminfo as bytes, keyed by field name.
function parseMeminfo(text) {
  var out = Object.create(null)
  var rows = lines(text)
  for (var i = 0; i < rows.length; i++) {
    var m = /^([A-Za-z0-9_()]{1,40}):\s+(\d{1,15})(?:\s+kB)?\s*$/.exec(rows[i])
    if (m) out[m[1]] = Number(m[2]) * (/kB\s*$/.test(rows[i]) ? 1024 : 1)
  }
  return out
}

// mem_used_total (third field) of a zram device: the RAM its compressed pages occupy.
function parseZramUsed(text) {
  var parts = lines(text).length ? String(text).trim().split(/\s+/) : []
  var n = toCount(parts[2])
  return isNaN(n) ? 0 : n
}

function field(info, name) {
  var v = info[name]
  return typeof v === "number" && isFinite(v) ? v : 0
}

// Linux counterpart of the macOS MemorySnapshot. "Wired" is kernel memory that
// cannot be reclaimed, "Compressed" is zswap plus zram, "Cached" is reclaimable
// page cache, and "Used" is MemTotal - MemAvailable.
function memorySnapshot(info, zramBytes) {
  var total = field(info, "MemTotal")
  if (!(total > 0)) return null
  var shmem = field(info, "Shmem")
  var available = "MemAvailable" in info ? field(info, "MemAvailable") : field(info, "MemFree")
  var used = Math.max(0, total - available)
  return {
    total: total,
    used: used,
    fraction: clamp01(used / total),
    free: field(info, "MemFree"),
    app: field(info, "AnonPages") + shmem,
    wired: field(info, "SUnreclaim") + field(info, "KernelStack") + field(info, "PageTables"),
    compressed: field(info, "Zswap") + (zramBytes > 0 ? zramBytes : 0),
    cached: Math.max(0, field(info, "Buffers") + field(info, "Cached") + field(info, "SReclaimable") - shmem)
  }
}

function memoryColor(kind, pal) {
  switch (kind) {
  case "wired": return pal.memWired
  case "compressed": return pal.memCompressed
  case "cached": return pal.memCached
  case "free": return pal.memFree
  default: return pal.memAccent
  }
}

// Stacked bar segments, as MemoryCardModel.segments. Whatever the named kinds
// do not explain is drawn in the App colour, like the macOS unattributed part.
function memorySegments(m, pal) {
  if (!m || !(m.total > 0)) return []
  var named = m.app + m.wired + m.compressed + m.cached + m.free
  var unattributed = Math.max(0, m.total - named)
  var whole = Math.max(m.total, named)
  var parts = [
    ["app", m.app], ["unattributed", unattributed], ["wired", m.wired],
    ["compressed", m.compressed], ["cached", m.cached], ["free", m.free]
  ]
  var out = []
  for (var i = 0; i < parts.length; i++) {
    out.push({ kind: parts[i][0], bytes: parts[i][1], fraction: parts[i][1] / whole, color: memoryColor(parts[i][0], pal) })
  }
  return out
}

function memoryLegend(pal) {
  return [
    { label: "App", color: pal.memAccent },
    { label: "Wired", color: pal.memWired },
    { label: "Compressed", color: pal.memCompressed },
    { label: "Cached", color: pal.memCached },
    { label: "Free", color: pal.memFree }
  ]
}

function memoryRows(m, dp) {
  return [
    { key: "Used", value: memoryBytes(m ? m.used : 0, dp) },
    { key: "Total", value: memoryBytes(m ? m.total : 0, dp) },
    { key: "Wired", value: memoryBytes(m ? m.wired : 0, dp) },
    { key: "Compressed", value: memoryBytes(m ? m.compressed : 0, dp) }
  ]
}

// --- Disk ------------------------------------------------------------------

// Whole disks only: partitions, device-mapper, loop, zram and md devices would
// count the same bytes twice.
var WHOLE_DISK = /^(sd[a-z]{1,3}|vd[a-z]{1,3}|xvd[a-z]{1,3}|hd[a-z]{1,3}|nvme\d{1,3}n\d{1,3}|mmcblk\d{1,3})$/

// Bytes read and written since boot. diskstats sectors are always 512 bytes.
function parseDiskstats(text) {
  var read = 0
  var written = 0
  var rows = lines(text)
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i].trim().split(/\s+/)
    if (p.length < 10 || !WHOLE_DISK.test(p[2])) continue
    var r = toCount(p[5])
    var w = toCount(p[9])
    if (isNaN(r) || isNaN(w)) continue
    read += r * 512
    written += w * 512
  }
  return { read: read, written: written }
}

// `df -B1 --output=size,used,avail` output. Used is reported as Total - Free,
// like the macOS card, so the three rows always add up.
function parseDf(text) {
  var rows = lines(text)
  for (var i = 0; i < rows.length; i++) {
    var m = /^\s*(\d{1,20})\s+(\d{1,20})\s+(\d{1,20})\s*$/.exec(rows[i])
    if (!m) continue
    var total = Number(m[1])
    var free = Number(m[3])
    if (!(total > 0) || free > total) return null
    return { total: total, free: free, used: total - free, fraction: clamp01((total - free) / total) }
  }
  return null
}

function diskRows(d, dp) {
  return [
    { key: "Used", value: d ? capacityBytes(d.used, dp) : UNAVAILABLE },
    { key: "Free", value: d ? capacityBytes(d.free, dp) : UNAVAILABLE },
    { key: "Total", value: d ? capacityBytes(d.total, dp) : UNAVAILABLE }
  ]
}

// --- Network ---------------------------------------------------------------

// Loopback and virtual links (bridges, containers, VPN tunnels) carry traffic
// that also crosses a physical interface, so they are left out of the totals.
var VIRTUAL_LINK = /^(lo|veth|docker|br-|virbr|vnet|tailscale|tun|tap|wg|zt)/

function parseNetDev(text) {
  var rx = 0
  var tx = 0
  var rows = lines(text)
  for (var i = 0; i < rows.length; i++) {
    var colon = rows[i].indexOf(":")
    if (colon < 0) continue
    var name = rows[i].slice(0, colon).trim()
    if (name === "" || VIRTUAL_LINK.test(name)) continue
    var p = rows[i].slice(colon + 1).trim().split(/\s+/)
    var r = toCount(p[0])
    var t = toCount(p[8])
    if (isNaN(r) || isNaN(t)) continue
    rx += r
    tx += t
  }
  return { rx: rx, tx: tx }
}

function networkRows(n, dp) {
  return [
    { key: "Total In", value: n ? capacityBytes(n.totalIn, dp) : UNAVAILABLE },
    { key: "Total Out", value: n ? capacityBytes(n.totalOut, dp) : UNAVAILABLE }
  ]
}

// Both lines share one scale so their heights compare; the floor keeps idle
// noise flat instead of filling the graph.
function networkScale(download, upload) {
  var top = NETWORK_GRAPH_FLOOR
  for (var i = 0; i < download.length; i++) if (download[i] > top) top = download[i]
  for (var j = 0; j < upload.length; j++) if (upload[j] > top) top = upload[j]
  return top
}

function normalise(samples, scale) {
  var out = []
  for (var i = 0; i < samples.length; i++) out.push(scale > 0 ? samples[i] / scale : 0)
  return out
}

// --- Shared ----------------------------------------------------------------

function rate(previous, current, seconds) {
  if (!(seconds > 0)) return 0
  var d = current - previous
  return d > 0 && isFinite(d) ? d / seconds : 0
}

function pushHistory(history, value, capacity) {
  var n = Number(value)
  var out = history.slice(Math.max(0, history.length - capacity + 1))
  out.push(isFinite(n) ? n : 0)
  return out
}

// Points of a sparkline whose newest sample sits on the right edge, as
// SparklineGeometry.points: a partly filled history grows in from the right.
function sparklinePoints(samples, capacity, width, height) {
  if (!(capacity > 0) || !(width > 0) || !(height > 0)) return []
  var visible = samples.slice(Math.max(0, samples.length - capacity))
  var step = capacity > 1 ? width / (capacity - 1) : 0
  var newest = visible.length - 1
  var out = []
  for (var i = 0; i < visible.length; i++) {
    out.push({ x: width - step * (newest - i), y: height * (1 - clamp01(visible[i])) })
  }
  return out
}

// --- Formatting ------------------------------------------------------------

function decimal(value, digits, dp) {
  return value.toFixed(digits).replace(".", dp || ".")
}

function trimmed(value, digits, dp) {
  var s = value.toFixed(digits)
  if (digits > 0) s = s.replace(/\.?0+$/, "")
  return s.replace(".", dp || ".")
}

function percentInt(fraction) {
  return Math.round(clamp01(fraction) * 100) + "%"
}

function percent1(fraction, dp) {
  return decimal(clamp01(fraction) * 100, 1, dp) + "%"
}

function temperature(celsius, dp) {
  if (typeof celsius !== "number" || !isFinite(celsius)) return UNAVAILABLE
  return decimal(celsius, 1, dp) + " °C"
}

function scaledBytes(bytes, step, units, dp) {
  var value = Number(bytes)
  if (!isFinite(value) || value <= 0) return "0 B"
  var unit = 0
  while (unit < units.length - 1 && value >= step) {
    value /= step
    unit++
  }
  var digits = unit <= 1 ? 0 : (unit === 2 ? 1 : 2)
  return trimmed(value, digits, dp) + " " + units[unit]
}

// Binary units, as the macOS .memory byte count style.
function memoryBytes(bytes, dp) {
  return scaledBytes(bytes, 1024, ["B", "KB", "MB", "GB", "TB"], dp)
}

// Decimal units, as the macOS .decimal byte count style.
function capacityBytes(bytes, dp) {
  return scaledBytes(bytes, 1000, ["B", "kB", "MB", "GB", "TB"], dp)
}

// ByteFormatter.throughput: steps of 1000, whole bytes, one decimal above.
function throughput(bytesPerSecond, dp) {
  var units = ["B", "kB", "MB", "GB", "TB"]
  var value = Number(bytesPerSecond)
  if (!isFinite(value) || value < 0) value = 0
  var unit = 0
  while (unit < units.length - 1 && Number(value.toFixed(unit === 0 ? 0 : 1)) >= 1000) {
    value /= 1000
    unit++
  }
  return decimal(value, unit === 0 ? 0 : 1, dp) + " " + units[unit] + "/s"
}

function tooltip(cpu, memory, dp) {
  return "CPU " + percent1(cpu ? cpu.total : 0, dp) + " · Memory " + percent1(memory ? memory.fraction : 0, dp)
}
