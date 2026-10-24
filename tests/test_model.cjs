// Run with: node tests/test_model.cjs
const fs = require("fs")
const vm = require("vm")
const path = require("path")
const assert = require("assert/strict")

const ctx = {}
vm.createContext(ctx)
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8").replace(".pragma library", ""),
  ctx
)
const M = ctx

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log("ok - " + name)
}
const SHELL = { foreground: "#eeeeee", background: "#111111", accent: "#abcdef", urgent: "#ff0000", muted: "#777777", popupBackground: "#222222", popupText: "#dddddd" }
const THEME = [
  'accent = "#b59790"',
  'foreground = "#FAFCFB"',
  'red = "#c38b7b"',
  'yellow = "#6B5E73"',
  "green = '#87a9b0'",
  'blue = "#b59790"',
  'magenta = "#c4d8e2"',
  'color6 = "#a5a0b6"',
  'bright_red = "#ffffff"',
  ''
].join("\n")
const PAL = { cpuAccent: "#1", cpuEfficiency: "#2", memAccent: "#3", memWired: "#4", memCompressed: "#5", memCached: "#6", memFree: "#7", textPrimary: "#8" }
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

const STAT_A = [
  "cpu  100 0 50 800 50 0 0 0 0 0",
  "cpu0 50 0 25 400 25 0 0 0 0 0",
  "cpu1 50 0 25 400 25 0 0 0 0 0",
  "intr 1 2 3",
  ""
].join("\n")
const STAT_B = [
  "cpu  160 0 70 900 70 0 0 0 0 0",
  "cpu0 100 0 35 440 25 0 0 0 0 0",
  "cpu1 60 0 35 460 45 0 0 0 0 0",
  ""
].join("\n")

test("parseCpuStat reads the aggregate and every core", () => {
  const s = M.parseCpuStat(STAT_A)
  assert.equal(s.cores.length, 2)
  assert.equal(s.total.user, 100)
  assert.equal(s.total.system, 50)
  assert.equal(s.total.idle, 850) // idle + iowait
  assert.equal(s.total.all, 1000)
})

test("parseCpuStat rejects malformed input", () => {
  assert.equal(M.parseCpuStat(""), null)
  assert.equal(M.parseCpuStat("garbage"), null)
  assert.equal(M.parseCpuStat(null), null)
})

test("cpuUsage derives total, user, system and per-core fractions from two samples", () => {
  const u = M.cpuUsage(M.parseCpuStat(STAT_A), M.parseCpuStat(STAT_B), null)
  // deltas: user 60, system 20, idle 120, all 200
  near(u.total, 80 / 200)
  near(u.user, 60 / 200)
  near(u.system, 20 / 200)
  near(u.cores[0].usage, 60 / 100) // core0: busy 60 of 100
  near(u.cores[1].usage, 20 / 100) // core1: busy 20 of 100
  assert.equal(u.performanceAverage, null)
  assert.equal(u.efficiencyAverage, null)
  assert.equal(u.cores[0].level, "unknown")
})

test("cpuUsage splits hybrid cores into P and E averages", () => {
  const u = M.cpuUsage(M.parseCpuStat(STAT_A), M.parseCpuStat(STAT_B), { performance: [0], efficiency: [1] })
  near(u.performanceAverage, 0.6)
  near(u.efficiencyAverage, 0.2)
  assert.equal(u.cores[0].level, "performance")
  assert.equal(u.cores[1].level, "efficiency")
})

test("cpuUsage returns null without a previous sample and clamps counter resets", () => {
  assert.equal(M.cpuUsage(null, M.parseCpuStat(STAT_A), null), null)
  const u = M.cpuUsage(M.parseCpuStat(STAT_B), M.parseCpuStat(STAT_A), null)
  assert.equal(u.total, 0)
})

test("parseCpuList expands kernel CPU ranges", () => {
  assert.deepEqual(Array.from(M.parseCpuList("0-3,8,10-11\n")), [0, 1, 2, 3, 8, 10, 11])
  assert.deepEqual(Array.from(M.parseCpuList("")), [])
  assert.deepEqual(Array.from(M.parseCpuList("0-99999")), [])
})

test("coreGroups mirrors the macOS card: one Cores group without levels", () => {
  const cores = [{ index: 0, usage: 0.1, level: "unknown" }, { index: 1, usage: 0.2, level: "unknown" }]
  const g = M.coreGroups(cores, PAL)
  assert.equal(g.length, 1)
  assert.equal(g[0].title, "Cores")
  const hybrid = M.coreGroups([{ index: 0, usage: 0, level: "performance" }, { index: 1, usage: 0, level: "efficiency" }], PAL)
  assert.deepEqual(Array.from(hybrid, (x) => x.title), ["P-Cores", "E-Cores"])
  assert.equal(M.coreGroups([], PAL).length, 0)
  assert.equal(hybrid[0].color, PAL.cpuAccent)
  assert.equal(hybrid[1].color, PAL.cpuEfficiency)
})

test("chunk splits core bars into rows of eight", () => {
  const rows = M.chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 8)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].length, 2)
})

const MEMINFO = [
  "MemTotal:       16000000 kB",
  "MemFree:         2000000 kB",
  "MemAvailable:    6000000 kB",
  "Buffers:          500000 kB",
  "Cached:          4000000 kB",
  "Shmem:            200000 kB",
  "SReclaimable:     300000 kB",
  "SUnreclaim:       250000 kB",
  "KernelStack:       50000 kB",
  "PageTables:       100000 kB",
  "AnonPages:       7000000 kB",
  "Zswap:            100000 kB",
  ""
].join("\n")

test("memorySnapshot maps meminfo onto the macOS segments", () => {
  const m = M.memorySnapshot(M.parseMeminfo(MEMINFO), 0)
  const k = 1024
  assert.equal(m.total, 16000000 * k)
  assert.equal(m.used, 10000000 * k)
  assert.equal(m.free, 2000000 * k)
  assert.equal(m.app, 7200000 * k) // AnonPages + Shmem
  assert.equal(m.wired, 400000 * k) // SUnreclaim + KernelStack + PageTables
  assert.equal(m.compressed, 100000 * k) // Zswap
  assert.equal(m.cached, 4600000 * k) // Buffers + Cached + SReclaimable - Shmem
  near(m.fraction, 10 / 16)
})

test("memorySnapshot adds zram usage to compressed and returns null without MemTotal", () => {
  const m = M.memorySnapshot(M.parseMeminfo(MEMINFO), 4096)
  assert.equal(m.compressed, 100000 * 1024 + 4096)
  assert.equal(M.memorySnapshot(M.parseMeminfo("MemFree: 1 kB"), 0), null)
})

test("memorySegments covers the bar with unattributed in the App colour", () => {
  const segs = M.memorySegments(M.memorySnapshot(M.parseMeminfo(MEMINFO), 0), PAL)
  assert.deepEqual(Array.from(segs, (s) => s.kind), ["app", "unattributed", "wired", "compressed", "cached", "free"])
  assert.equal(segs[1].color, segs[0].color)
  near(segs.reduce((a, s) => a + s.fraction, 0), 1)
  assert.equal(segs[2].color, PAL.memWired)
  assert.equal(M.memorySegments(null, PAL).length, 0)
})

test("parseZramUsed reads mem_used_total from mm_stat", () => {
  assert.equal(M.parseZramUsed("4096 1024 2048 0 2048 0 0 0 0\n"), 2048)
  assert.equal(M.parseZramUsed(""), 0)
})

test("parseDiskstats sums whole disks only", () => {
  const text = [
    " 259       0 nvme0n1 100 0 2000 0 50 0 4000 0 0 0 0",
    " 259       1 nvme0n1p1 10 0 999 0 5 0 999 0 0 0 0",
    " 253       0 dm-0 1 0 777 0 1 0 777 0 0 0 0",
    "   8       0 sda 1 0 10 0 1 0 20 0 0 0 0",
    "   7       0 loop0 1 0 555 0 1 0 555 0 0 0 0",
    " 252       0 zram0 1 0 555 0 1 0 555 0 0 0 0",
    ""
  ].join("\n")
  const d = M.parseDiskstats(text)
  assert.equal(d.read, (2000 + 10) * 512)
  assert.equal(d.written, (4000 + 20) * 512)
})

test("parseNetDev sums every interface except loopback", () => {
  const text = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0",
    "  eth0: 1000 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0",
    " wlan0: 50 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0",
    ""
  ].join("\n")
  const n = M.parseNetDev(text)
  assert.equal(n.rx, 1050)
  assert.equal(n.tx, 207)
})

test("parseDf reads size, used and available bytes", () => {
  const d = M.parseDf("     1B-blocks         Used        Avail\n494380000000 409350000000 85030000000\n")
  assert.equal(d.total, 494380000000)
  assert.equal(d.free, 85030000000)
  assert.equal(d.used, 409350000000)
  near(d.fraction, 409350000000 / 494380000000)
  assert.equal(M.parseDf("nope"), null)
})

test("rate is bytes per second and never negative", () => {
  assert.equal(M.rate(1000, 3000, 2), 1000)
  assert.equal(M.rate(3000, 1000, 2), 0)
  assert.equal(M.rate(0, 1000, 0), 0)
})

test("percent formatters match the macOS app", () => {
  assert.equal(M.percentInt(0.264), "26%")
  assert.equal(M.percentInt(1), "100%")
  assert.equal(M.percent1(0.167, "."), "16.7%")
  assert.equal(M.percent1(0.167, ","), "16,7%")
  assert.equal(M.percent1(NaN, "."), "0.0%")
})

test("byte formatters: memory is binary, capacity is decimal, both trim zeros", () => {
  assert.equal(M.memoryBytes(24 * 1024 ** 3, "."), "24 GB")
  assert.equal(M.memoryBytes(19.66 * 1024 ** 3, ","), "19,66 GB")
  assert.equal(M.capacityBytes(651000000, "."), "651 MB")
  assert.equal(M.capacityBytes(27190000000, "."), "27.19 GB")
  assert.equal(M.capacityBytes(0, "."), "0 B")
})

test("throughput formatter steps by 1000 with one decimal above bytes", () => {
  assert.equal(M.throughput(0, "."), "0 B/s")
  assert.equal(M.throughput(999, "."), "999 B/s")
  assert.equal(M.throughput(78300, ","), "78,3 kB/s")
  assert.equal(M.throughput(3200000, "."), "3.2 MB/s")
  assert.equal(M.throughput(999960, "."), "1.0 MB/s")
})

test("pushHistory keeps the newest samples up to capacity", () => {
  let h = []
  for (let i = 0; i < 5; i++) h = M.pushHistory(h, i, 3)
  assert.deepEqual(Array.from(h), [2, 3, 4])
  assert.deepEqual(Array.from(M.pushHistory([], NaN, 3)), [0])
})

test("network graph shares one scale with a 10 kB/s floor", () => {
  assert.equal(M.networkScale([1, 2], [3]), 10000)
  assert.equal(M.networkScale([50000], [20000]), 50000)
  assert.deepEqual(Array.from(M.normalise([5000, 10000], 10000)), [0.5, 1])
})

test("sparklinePoints anchors the newest sample to the right edge", () => {
  const p = M.sparklinePoints([0, 1], 3, 100, 10)
  assert.equal(p.length, 2)
  assert.deepEqual([p[1].x, p[1].y], [100, 0])
  assert.deepEqual([p[0].x, p[0].y], [50, 10])
})

test("parseThemeColors reads named and numbered ANSI colours", () => {
  const c = M.parseThemeColors(THEME)
  assert.equal(c.red, "#c38b7b")
  assert.equal(c.green, "#87a9b0")
  assert.equal(c.cyan, "#a5a0b6") // from color6
  assert.equal(c.bright_red, undefined) // only base colours are kept
  assert.equal(Object.keys(M.parseThemeColors("x".repeat(70000))).length, 0)
  assert.equal(Object.keys(M.parseThemeColors(null)).length, 0)
})

test("themePalette maps the macOS roles onto theme colours", () => {
  const p = M.themePalette(M.parseThemeColors(THEME), SHELL)
  assert.equal(p.cpuAccent, "#b59790") // blue
  assert.equal(p.cpuEfficiency, "#a5a0b6") // cyan
  assert.equal(p.memAccent, "#6B5E73") // yellow
  assert.equal(p.memWired, "#c38b7b") // red
  assert.equal(p.memCompressed, "#c4d8e2") // magenta
  assert.equal(p.memCached, "#b59790") // blue
  assert.equal(p.memFree, "#87a9b0") // green
  assert.equal(p.diskAccent, "#87a9b0")
  assert.equal(p.networkAccent, "#c4d8e2")
  assert.equal(p.networkDownload, "#87a9b0")
  assert.equal(p.networkUpload, "#b59790")
  assert.equal(p.panelBackground, "#222222")
  assert.equal(p.textPrimary, "#dddddd")
})

test("themePalette falls back to shell roles when the theme has no ANSI colours", () => {
  const p = M.themePalette({}, SHELL)
  assert.equal(p.cpuAccent, "#abcdef") // accent
  assert.equal(p.memWired, "#ff0000") // urgent
  assert.equal(p.memFree, "#abcdef")
})

test("memoryLegend and cpuRows take their colours from the palette", () => {
  const p = M.themePalette(M.parseThemeColors(THEME), SHELL)
  assert.deepEqual(Array.from(M.memoryLegend(p), (e) => e.color), [p.memAccent, p.memWired, p.memCompressed, p.memCached, p.memFree])
  const rows = M.cpuRows({ user: 0, system: 0, performanceAverage: 0.5, efficiencyAverage: 0.1 }, ".", p)
  assert.equal(rows[0].color, p.textPrimary)
  assert.equal(rows[2].color, p.cpuAccent)
  assert.equal(rows[3].color, p.cpuEfficiency)
})

console.log(`\n${passed} tests passed`)
