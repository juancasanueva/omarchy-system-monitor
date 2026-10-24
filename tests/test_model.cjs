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

test("isCpuSensor matches the CPU hwmon drivers only", () => {
  for (const name of ["k10temp\n", "zenpower", "coretemp\n", "cpu_thermal"]) assert.equal(M.isCpuSensor(name), true, name)
  for (const name of ["nvme\n", "amdgpu", "acpitz", "", null, undefined]) assert.equal(M.isCpuSensor(name), false, String(name))
})

test("parseTemperature turns hwmon millidegrees into Celsius", () => {
  assert.equal(M.parseTemperature("38125\n"), 38.125)
  assert.equal(M.parseTemperature("-5000"), -5)
  assert.equal(M.parseTemperature(""), null)
  assert.equal(M.parseTemperature("abc"), null)
  assert.equal(M.parseTemperature("999999"), null)
  assert.equal(M.parseTemperature(undefined), null)
})

test("temperature formats one decimal with the locale separator", () => {
  assert.equal(M.temperature(38.125, "."), "38.1 °C")
  assert.equal(M.temperature(38.125, ","), "38,1 °C")
  assert.equal(M.temperature(null, "."), M.UNAVAILABLE)
})

test("cpuRows adds a Temperature row only when a reading exists", () => {
  const usage = { user: 0.1, system: 0.05, performanceAverage: null, efficiencyAverage: null }
  assert.deepEqual(Array.from(M.cpuRows(usage, ".", PAL), (r) => r.key), ["User", "System"])
  assert.deepEqual(Array.from(M.cpuRows(usage, ".", PAL, null), (r) => r.key), ["User", "System"])
  const rows = M.cpuRows(usage, ".", PAL, 54.5)
  assert.deepEqual(Array.from(rows, (r) => r.key), ["User", "System", "Temperature"])
  assert.equal(rows[2].value, "54.5 °C")
  assert.equal(rows[2].color, PAL.textPrimary)
})

const GPU_FILES = {
  busy: "11\n",
  memBusy: "",
  vramUsed: "1084268544\n",
  vramTotal: "4294967296\n",
  gttUsed: "79552512\n",
  gttTotal: "14475911168\n",
  temp: "33000\n",
  powerAverage: "11104000\n",
  powerInput: "11075000\n",
  sclk: "1127000000\n",
  mclk: "",
  vddgfx: "0\n"
}

test("gpuSnapshot reads the amdgpu sysfs and hwmon files", () => {
  const g = M.gpuSnapshot(GPU_FILES)
  near(g.busy, 0.11)
  assert.equal(g.memBusy, null)
  assert.equal(g.vramUsed, 1084268544)
  assert.equal(g.vramTotal, 4294967296)
  assert.equal(g.gttUsed, 79552512)
  assert.equal(g.gttTotal, 14475911168)
  assert.equal(g.temperature, 33)
  near(g.watts, 11.104)
  assert.equal(g.coreMhz, 1127)
  assert.equal(g.memoryMhz, null)
  assert.equal(g.vddgfx, null)
})

test("gpuSnapshot falls back to power1_input and is null without a busy reading", () => {
  near(M.gpuSnapshot(Object.assign({}, GPU_FILES, { powerAverage: "" })).watts, 11.075)
  assert.equal(M.gpuSnapshot(Object.assign({}, GPU_FILES, { busy: "" })), null)
  assert.equal(M.gpuSnapshot(Object.assign({}, GPU_FILES, { busy: "abc" })), null)
  assert.equal(M.gpuSnapshot({}), null)
  const sparse = M.gpuSnapshot({ busy: "250" })
  assert.equal(sparse.busy, 1)
  assert.equal(sparse.vramTotal, null)
  assert.equal(sparse.temperature, null)
})

test("gpuMemory gives VRAM and shared memory with their used fraction", () => {
  const rows = M.gpuMemory(M.gpuSnapshot(GPU_FILES), ".", { gpuAccent: "#9" })
  assert.deepEqual(Array.from(rows, (r) => [r.key, r.value, r.color]), [
    ["VRAM", "1.01 GB / 4 GB", "#9"],
    ["Shared", "75.9 MB / 13.48 GB", "#9"]
  ])
  near(rows[0].fraction, 1084268544 / 4294967296)
  near(rows[1].fraction, 79552512 / 14475911168)
  assert.deepEqual(Array.from(M.gpuMemory(M.gpuSnapshot({ busy: "5" }), ".", PAL)), [])
  assert.deepEqual(Array.from(M.gpuMemory(null, ".", PAL)), [])
})

test("gpuRows shows every other reading the GPU reports, and only those", () => {
  const rows = M.gpuRows(M.gpuSnapshot(GPU_FILES), ".", PAL)
  assert.deepEqual(Array.from(rows, (r) => [r.key, r.value]), [
    ["Temperature", "33.0 °C"],
    ["Power", "11.1 W"],
    ["Core clock", "1127 MHz"]
  ])
  const full = M.gpuRows(M.gpuSnapshot(Object.assign({}, GPU_FILES, { memBusy: "40", mclk: "2800000000", vddgfx: "850" })), ",", PAL)
  assert.deepEqual(Array.from(full, (r) => r.key), ["Memory busy", "Temperature", "Power", "Core clock", "Memory clock", "Voltage"])
  assert.equal(full[0].value, "40,0%")
  assert.equal(full[2].value, "11,1 W")
  assert.equal(full[4].value, "2800 MHz")
  assert.equal(full[5].value, "850 mV")
  assert.deepEqual(Array.from(M.gpuRows(null, ".", PAL)), [])
})

test("themePalette gives the GPU the cyan hue, or the accent without one", () => {
  assert.equal(M.themePalette(M.parseThemeColors(THEME), SHELL).gpuAccent, "#a5a0b6")
  assert.equal(M.themePalette({}, SHELL).gpuAccent, SHELL.accent)
})

const PCI_IDS = [
  "# comment",
  "1002  Advanced Micro Devices, Inc. [AMD/ATI]",
  "\t1111  Other GPU",
  "\t1114  Krackan [Radeon 840M / 860M Graphics]",
  "\t\t1f66 0030  Some subsystem",
  "\t15bf  Phoenix1",
  "1003  ULSI Systems",
  "\t1114  Wrong vendor device",
  ""
].join("\n")

test("pciDeviceName finds the device under its vendor in pci.ids", () => {
  assert.equal(M.pciDeviceName(PCI_IDS, "0x1002\n", "0x1114\n"), "Radeon 840M / 860M Graphics")
  assert.equal(M.pciDeviceName(PCI_IDS, "0x1002", "0x15bf"), "Phoenix1")
  assert.equal(M.pciDeviceName(PCI_IDS, "0x1003", "0x1114"), "Wrong vendor device")
  assert.equal(M.pciDeviceName(PCI_IDS, "0x1002", "0x9999"), "")
  assert.equal(M.pciDeviceName(PCI_IDS, "0x10de", "0x1114"), "")
  assert.equal(M.pciDeviceName(PCI_IDS, "garbage", "0x1114"), "")
  assert.equal(M.pciDeviceName("", "0x1002", "0x1114"), "")
  assert.equal(M.pciDeviceName(null, "0x1002", "0x1114"), "")
})

test("gpuName prefers amdgpu's product_name over pci.ids", () => {
  assert.equal(M.gpuName("AMD Radeon RX 7800 XT\n", PCI_IDS, "0x1002", "0x1114"), "AMD Radeon RX 7800 XT")
  assert.equal(M.gpuName("", PCI_IDS, "0x1002", "0x1114"), "Radeon 840M / 860M Graphics")
  assert.equal(M.gpuName(undefined, "", "0x1002", "0x1114"), "")
})

test("cpuName reads the first model name and drops marketing noise", () => {
  const info = (name) => `processor\t: 0\nvendor_id\t: x\nmodel name\t: ${name}\nflags\t\t: fpu\n\nprocessor\t: 1\nmodel name\t: other\n`
  assert.equal(M.cpuName(info("AMD Ryzen AI 7 350 w/ Radeon 860M")), "AMD Ryzen AI 7 350")
  assert.equal(M.cpuName(info("AMD Ryzen 7 5800X 8-Core Processor             ")), "AMD Ryzen 7 5800X")
  assert.equal(M.cpuName(info("AMD Ryzen 5 5600G with Radeon Graphics")), "AMD Ryzen 5 5600G")
  assert.equal(M.cpuName(info("Intel(R) Core(TM) i7-1165G7 @ 2.80GHz")), "Intel Core i7-1165G7")
  assert.equal(M.cpuName(info("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz")), "Intel Xeon E5-2680 v4")
  assert.equal(M.cpuName(info("13th Gen Intel(R) Core(TM) i7-1360P")), "13th Gen Intel Core i7-1360P")
  assert.equal(M.cpuName("processor\t: 0\nBogoMIPS\t: 108.00\n"), "")
  assert.equal(M.cpuName(""), "")
  assert.equal(M.cpuName(null), "")
})

test("barModules orders CPU, GPU, MEM and drops GPU without a GPU", () => {
  assert.deepEqual(Array.from(M.barModules(true, true, true, true)), ["cpu", "gpu", "memory"])
  assert.deepEqual(Array.from(M.barModules(true, true, true, false)), ["cpu", "memory"])
  assert.deepEqual(Array.from(M.barModules(true, true, false, true)), ["cpu", "memory"])
  assert.deepEqual(Array.from(M.barModules(false, false, true, true)), ["gpu"])
  assert.deepEqual(Array.from(M.barModules(false, false, false, true)), [])
})

test("tooltip adds the GPU only when there is one", () => {
  const cpu = { total: 0.12 }
  const memory = { fraction: 0.5 }
  assert.equal(M.tooltip(cpu, memory, null, "."), "CPU 12.0% · Memory 50.0%")
  assert.equal(M.tooltip(cpu, memory, { busy: 0.165 }, ","), "CPU 12,0% · GPU 16,5% · Memory 50,0%")
  assert.equal(M.tooltip(null, null, null, "."), "CPU 0.0% · Memory 0.0%")
})

test("withBarSetting merges one switch into the whole entry", () => {
  const entry = { showCpu: true, showMemory: true, showGpu: true, custom: "kept" }
  const next = M.withBarSetting(entry, "showGpu", false, true)
  assert.deepEqual(JSON.parse(JSON.stringify(next)), { showCpu: true, showMemory: true, showGpu: false, custom: "kept" })
  assert.equal(entry.showGpu, true)
  assert.deepEqual(JSON.parse(JSON.stringify(M.withBarSetting({}, "showCpu", false, true))), { showCpu: false })
})

test("withBarSetting refuses to hide the last module on the bar", () => {
  assert.equal(M.withBarSetting({ showCpu: false, showGpu: false }, "showMemory", false, true), null)
  assert.equal(M.withBarSetting({ showMemory: false }, "showCpu", false, false), null)
  assert.notEqual(M.withBarSetting({ showMemory: false }, "showCpu", false, true), null)
  assert.notEqual(M.withBarSetting({ showCpu: false, showGpu: false, showMemory: false }, "showCpu", true, true), null)
})

test("withBarSetting only writes the three bar switches", () => {
  assert.equal(M.withBarSetting({}, "custom", false, true), null)
  assert.equal(M.withBarSetting({}, "__proto__", false, true), null)
})

test("barSwitches lists CPU, GPU and MEM with their state", () => {
  const rows = M.barSwitches({ showGpu: false }, true)
  assert.deepEqual(Array.from(rows, (r) => [r.key, r.label, r.checked, r.enabled]), [
    ["showCpu", "CPU", true, true],
    ["showGpu", "GPU", false, true],
    ["showMemory", "MEM", true, true]
  ])
  const noGpu = M.barSwitches({}, false)
  assert.equal(noGpu[1].enabled, false)
  assert.equal(noGpu[1].note, "No supported GPU")
  assert.equal(noGpu[0].note, "")
})

console.log(`\n${passed} tests passed`)
