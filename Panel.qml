import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// System Monitor: an Omarchy port of the macOS menu bar app
// (github.com/juancasanueva/SWIFTUI_system_monitor). The bar shows CPU, GPU
// and memory with a sparkline each; the panel shows the CPU, GPU, Memory, Disk
// and Network cards.
Panel {
  id: root
  moduleName: "juancasanueva.system-monitor"
  ipcTarget: "juancasanueva.system-monitor"

  readonly property bool showCpu: setting("showCpu", true) !== false
  readonly property bool showMemory: setting("showMemory", true) !== false
  readonly property bool showGpu: setting("showGpu", true) !== false
  readonly property var barModules: Model.barModules(root.showCpu, root.showMemory, root.showGpu, root.hasGpu)

  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
  readonly property string dp: Qt.locale().decimalPoint
  // --- theme -----------------------------------------------------------------

  // The macOS colour roles, assigned from the current Omarchy theme: ANSI hues
  // from its colors.toml for the metrics, the shell's popup roles for surfaces.
  property var themeColors: ({})
  readonly property var pal: {
    var p = Model.themePalette(root.themeColors, {
      foreground: Commons.Color.foreground,
      background: Commons.Color.background,
      accent: Commons.Color.accent,
      urgent: Commons.Color.urgent,
      muted: Commons.Color.muted,
      popupBackground: Commons.Color.popups.background,
      popupText: Commons.Color.popups.text
    })
    p.cardBackground = Qt.alpha(Commons.Color.popups.text, 0.05)
    p.textSecondary = Qt.alpha(Commons.Color.popups.text, 0.6)
    return p
  }

  // The same file the shell reads for its own colours; re-read on edit and on
  // every theme switch.
  FileView {
    id: themeFile
    path: Commons.Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.themeColors = Model.parseThemeColors(text())
    onLoadFailed: root.themeColors = ({})
  }

  Connections {
    target: Commons.Color
    function onAccentChanged() { themeFile.reload() }
    function onForegroundChanged() { themeFile.reload() }
  }

  // --- sampling --------------------------------------------------------------

  // Two seconds while only the bar is visible, one while the panel is open
  // (Application/SamplingCadence.swift).
  readonly property int sampleInterval: root.opened ? 1000 : 2000

  property var topology: null
  property var cpuSample: null
  property var cpu: null
  property var cpuHistory: []
  property var cpuTemperature: null
  property string cpuName: ""
  property string gpuKind: ""
  property string gpuCard: ""
  property string gpuDevice: ""
  property string gpuHwmon: ""
  property string gpuSlot: ""
  property var gpuFileList: []
  readonly property bool hasGpu: root.gpuDevice !== ""
  property string gpuName: ""
  property var gpu: null
  property var gpuHistory: []
  property var memory: null
  property var memoryHistory: []
  property var disk: null
  property var diskCounters: null
  property real diskRead: 0
  property real diskWrite: 0
  property bool diskRatesKnown: false
  property var netCounters: null
  property var network: null
  property var downloadHistory: []
  property var uploadHistory: []
  property double lastSampleMs: 0

  function readText(view) {
    view.reload()
    return view.text()
  }

  function loadTopology() {
    var performance = Model.parseCpuList(readText(pCoresFile))
    var efficiency = Model.parseCpuList(readText(eCoresFile))
    root.topology = performance.length > 0 && efficiency.length > 0
      ? { performance: performance, efficiency: efficiency }
      : null
  }

  // hwmon numbering changes between boots, so the CPU sensor is found by its
  // driver name once at startup.
  function findCpuSensor() {
    for (var i = 0; i < Model.MAX_HWMON; i++) {
      hwmonNameFile.path = "/sys/class/hwmon/hwmon" + i + "/name"
      if (Model.isCpuSensor(readText(hwmonNameFile))) {
        cpuTempFile.path = "/sys/class/hwmon/hwmon" + i + "/temp1_input"
        return
      }
    }
  }

  // Every DRM card whose driver the widget knows is a candidate; the
  // discrete one with the most VRAM, then the display card, is followed. Its hwmon sits under the same
  // device, so readings never mix two GPUs.
  function findGpu() {
    var candidates = []
    for (var i = 0; i < Model.MAX_GPU_CARDS; i++) {
      var card = "/sys/class/drm/card" + i
      hwmonNameFile.path = card + "/device/uevent"
      var uevent = Model.parseUevent(readText(hwmonNameFile))
      var kind = Model.gpuKind(uevent.driver)
      if (!kind) continue
      hwmonNameFile.path = card + "/device/mem_info_vram_total"
      var vramTotal = Model.parseInteger(readText(hwmonNameFile)) || 0
      hwmonNameFile.path = card + "/device/boot_vga"
      var bootVga = Model.parseInteger(readText(hwmonNameFile)) === 1
      candidates.push({ index: i, kind: kind, slot: uevent.slot, vramTotal: vramTotal, bootVga: bootVga })
    }
    var pick = Model.pickGpu(candidates)
    if (!pick) return
    var card = "/sys/class/drm/card" + pick.index
    var device = card + "/device"
    for (var j = 0; j < Model.MAX_HWMON; j++) {
      hwmonNameFile.path = device + "/hwmon/hwmon" + j + "/name"
      if (Model.isGpuHwmon(pick.kind, readText(hwmonNameFile))) {
        root.gpuHwmon = device + "/hwmon/hwmon" + j
        break
      }
    }
    root.gpuKind = pick.kind
    root.gpuCard = card
    root.gpuSlot = pick.slot
    root.gpuDevice = device
    root.gpuName = readGpuName(device)
    root.gpuFileList = readableGpuFiles()
  }

  // Files the card cannot report (gpu_busy_percent on a Tahiti, say) fail on
  // every read and log each failure, so they are dropped once at startup. A
  // card asleep at startup keeps them all: its readings cannot be told apart.
  function readableGpuFiles() {
    var list = Model.gpuFiles(root.gpuKind)
    hwmonNameFile.path = root.gpuDevice + "/power/runtime_status"
    if (Model.gpuAsleep(readText(hwmonNameFile))) return list
    var out = []
    for (var i = 0; i < list.length; i++) {
      var path = gpuFilePath(list[i])
      if (path === "") continue
      hwmonNameFile.path = path
      if (readText(hwmonNameFile) !== "") out.push(list[i])
    }
    return out
  }

  // pci.ids is read once and released; its text is not kept.
  function readGpuName(device) {
    hwmonNameFile.path = device + "/product_name"
    var product = readText(hwmonNameFile)
    hwmonNameFile.path = device + "/vendor"
    var vendor = readText(hwmonNameFile)
    hwmonNameFile.path = device + "/device"
    var id = readText(hwmonNameFile)
    pciIdsFile.path = "/usr/share/hwdata/pci.ids"
    var name = Model.gpuName(product, readText(pciIdsFile), vendor, id)
    pciIdsFile.path = ""
    return name
  }

  function gpuFilePath(file) {
    var dir = file[1] === "device" ? root.gpuDevice : (file[1] === "card" ? root.gpuCard : root.gpuHwmon)
    return dir === "" ? "" : dir + "/" + file[2]
  }

  // The load graph only grows on GPUs that report a load.
  function setGpu(snapshot) {
    root.gpu = snapshot
    if (snapshot.busy !== null) root.gpuHistory = Model.pushHistory(root.gpuHistory, snapshot.busy, Model.GRAPH_SAMPLES)
  }

  function sampleGpu() {
    var list = root.gpuFileList
    var files = {}
    for (var i = 0; i < gpuFiles.count; i++) {
      var view = gpuFiles.objectAt(i)
      files[list[i][0]] = view && view.path !== "" ? readText(view) : ""
    }
    // nvidia-smi wakes a sleeping card, so it only runs while the card is awake.
    if (root.gpuKind === "nvidia" && !Model.gpuAsleep(files.runtime)) {
      if (!nvidiaProcess.running) nvidiaProcess.running = true
      return
    }
    setGpu(Model.gpuSnapshot(files))
  }

  function sample() {
    var now = Date.now()
    var seconds = root.lastSampleMs > 0 ? (now - root.lastSampleMs) / 1000 : 0
    root.lastSampleMs = now

    var stat = Model.parseCpuStat(readText(statFile))
    if (stat) {
      var usage = Model.cpuUsage(root.cpuSample, stat, root.topology)
      root.cpuSample = stat
      if (usage) {
        root.cpu = usage
        root.cpuHistory = Model.pushHistory(root.cpuHistory, usage.total, Model.GRAPH_SAMPLES)
      }
    }
    if (cpuTempFile.path !== "") root.cpuTemperature = Model.parseTemperature(readText(cpuTempFile))
    if (root.gpuDevice !== "") sampleGpu()

    var memory = Model.memorySnapshot(Model.parseMeminfo(readText(memFile)), Model.parseZramUsed(readText(zramFile)))
    if (memory) {
      root.memory = memory
      root.memoryHistory = Model.pushHistory(root.memoryHistory, memory.fraction, Model.GRAPH_SAMPLES)
    }

    var io = Model.parseDiskstats(readText(diskstatsFile))
    if (root.diskCounters && seconds > 0) {
      root.diskRead = Model.rate(root.diskCounters.read, io.read, seconds)
      root.diskWrite = Model.rate(root.diskCounters.written, io.written, seconds)
      root.diskRatesKnown = true
    }
    root.diskCounters = io

    var net = Model.parseNetDev(readText(netFile))
    if (root.netCounters && seconds > 0) {
      var down = Model.rate(root.netCounters.rx, net.rx, seconds)
      var up = Model.rate(root.netCounters.tx, net.tx, seconds)
      root.network = { totalIn: net.rx, totalOut: net.tx, download: down, upload: up }
      root.downloadHistory = Model.pushHistory(root.downloadHistory, down, Model.GRAPH_SAMPLES)
      root.uploadHistory = Model.pushHistory(root.uploadHistory, up, Model.GRAPH_SAMPLES)
    }
    root.netCounters = net
  }

  // Omarchy's TUI launcher: focuses a running btop or opens one in the default
  // terminal. The plugin's own app id keeps the window out of Omarchy's float
  // rule for org.omarchy.btop, so it tiles. Fixed argv, no shell.
  readonly property string btopAppId: "io.github.juancasanueva.btop"

  function openBtop() {
    root.close()
    Quickshell.execDetached(["/usr/bin/omarchy-launch-or-focus-tui", "--app-id=" + root.btopAppId, "btop"])
  }

  function refreshDisk() {
    if (!dfProcess.running) dfProcess.running = true
  }

  Component.onCompleted: {
    loadTopology()
    root.cpuName = Model.cpuName(readText(cpuinfoFile))
    findCpuSensor()
    findGpu()
    sample()
    refreshDisk()
  }

  onOpenedChanged: {
    if (root.opened) root.refreshDisk()
    else root.settingsOpen = false
  }

  // --- settings --------------------------------------------------------------

  property bool settingsOpen: false
  property string settingsStatus: ""

  // Saved through the shell into this widget's shell.json entry; the host
  // hands the new entry back as `settings`, which moves the bar and switches.
  function setBarSwitch(key, value) {
    if (Model.shown(root.settings, key) === value) return
    var next = Model.withBarSetting(root.settings, key, value, root.hasGpu)
    if (!next) {
      root.settingsStatus = "At least one module stays on the bar"
      return
    }
    var api = root.bar ? root.bar.shell : null
    if (!api || typeof api.updateEntryInline !== "function") {
      root.settingsStatus = "Could not save: no shell connection"
      return
    }
    root.settingsStatus = api.updateEntryInline(root.moduleName, next) === true ? "" : "Could not save the setting"
  }

  // Kernel-generated files of a few kilobytes; a blocking read is immediate.
  FileView { id: statFile; path: "/proc/stat"; blockAllReads: true; printErrors: false }
  FileView { id: memFile; path: "/proc/meminfo"; blockAllReads: true; printErrors: false }
  FileView { id: diskstatsFile; path: "/proc/diskstats"; blockAllReads: true; printErrors: false }
  FileView { id: netFile; path: "/proc/net/dev"; blockAllReads: true; printErrors: false }
  FileView { id: zramFile; path: "/sys/block/zram0/mm_stat"; blockAllReads: true; printErrors: false }
  FileView { id: pCoresFile; path: "/sys/devices/cpu_core/cpus"; blockAllReads: true; printErrors: false }
  FileView { id: eCoresFile; path: "/sys/devices/cpu_atom/cpus"; blockAllReads: true; printErrors: false }
  FileView { id: hwmonNameFile; blockAllReads: true; printErrors: false }
  FileView { id: cpuTempFile; blockAllReads: true; printErrors: false }
  FileView { id: cpuinfoFile; path: "/proc/cpuinfo"; blockAllReads: true; printErrors: false }
  FileView { id: pciIdsFile; blockAllReads: true; printErrors: false }

  Instantiator {
    id: gpuFiles
    model: root.gpuFileList
    delegate: FileView {
      required property var modelData
      path: root.gpuFilePath(modelData)
      blockAllReads: true
      printErrors: false
    }
  }

  Timer {
    interval: root.sampleInterval
    repeat: true
    running: true
    onTriggered: root.sample()
  }

  // Capacity changes slowly; the macOS app re-reads it on a long cadence too.
  Timer {
    interval: 30000
    repeat: true
    running: true
    onTriggered: root.refreshDisk()
  }

  // statvfs has no procfs file, so capacity comes from df. Fixed argv, no
  // shell, and the output is capped at 4 KiB while it streams.
  Process {
    id: dfProcess
    property string buffer: ""
    property bool overflow: false
    readonly property int maxBytes: 4096

    command: ["/usr/bin/df", "-B1", "--output=size,used,avail", "--", "/"]
    environment: ({ LC_ALL: "C" })

    onStarted: { buffer = ""; overflow = false }

    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        if (dfProcess.overflow) return
        if (dfProcess.buffer.length + chunk.length > dfProcess.maxBytes) {
          dfProcess.overflow = true
          dfProcess.buffer = ""
          dfProcess.signal(9)
          return
        }
        dfProcess.buffer += chunk
      }
    }

    onExited: function(code) {
      if (code === 0 && !overflow) {
        var parsed = Model.parseDf(buffer)
        if (parsed) root.disk = parsed
      }
      buffer = ""
    }
  }

  // NVIDIA's proprietary driver keeps its readings out of sysfs; nvidia-smi
  // reports the followed card by its PCI slot. Fixed argv, no shell, output
  // capped at 4 KiB. Without nvidia-smi the card shows with no readings.
  Process {
    id: nvidiaProcess
    property string buffer: ""
    property bool overflow: false
    readonly property int maxBytes: 4096

    command: ["/usr/bin/nvidia-smi", "--query-gpu=" + Model.NVIDIA_QUERY, "--format=csv,noheader,nounits", "--id=" + root.gpuSlot]
    environment: ({ LC_ALL: "C" })

    onStarted: { buffer = ""; overflow = false }

    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        if (nvidiaProcess.overflow) return
        if (nvidiaProcess.buffer.length + chunk.length > nvidiaProcess.maxBytes) {
          nvidiaProcess.overflow = true
          nvidiaProcess.buffer = ""
          nvidiaProcess.signal(9)
          return
        }
        nvidiaProcess.buffer += chunk
      }
    }

    onExited: function(code) {
      var parsed = code === 0 && !overflow ? Model.nvidiaSnapshot(buffer) : null
      root.setGpu(parsed || Model.emptyGpu())
      buffer = ""
    }
  }

  Component.onDestruction: {
    if (dfProcess.running) dfProcess.signal(9)
    if (nvidiaProcess.running) nvidiaProcess.signal(9)
  }

  // --- bar -------------------------------------------------------------------

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function moduleLabel(module) { return module === "cpu" ? "CPU" : (module === "gpu" ? "GPU" : "MEM") }
  function moduleAccent(module) {
    if (module === "cpu") return root.pal.cpuAccent
    return module === "gpu" ? root.pal.gpuAccent : root.pal.memAccent
  }
  function moduleFraction(module) {
    if (module === "cpu") return root.cpu ? root.cpu.total : 0
    if (module === "gpu") return root.gpu && root.gpu.busy !== null ? root.gpu.busy : 0
    return root.memory ? root.memory.fraction : 0
  }
  function moduleValue(module) {
    if (module === "gpu") return Model.gpuLoadText(root.gpu, root.dp, true)
    return Model.percentInt(root.moduleFraction(module))
  }
  function moduleSamples(module) {
    var history = module === "cpu" ? root.cpuHistory : (module === "gpu" ? root.gpuHistory : root.memoryHistory)
    return history.slice(Math.max(0, history.length - Model.BAR_SAMPLES))
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: root.barModules.length > 0
    fixedWidth: vertical ? -1 : barCard.width + Style.space(8)
    fixedHeight: vertical ? barColumn.implicitHeight + Style.space(12) : -1
    tooltipText: Model.tooltip(root.cpu, root.memory, root.gpu, root.dp) + "\nClick for details · Right-click: btop"
    onPressed: function(b) {
      if (b === Qt.RightButton) root.openBtop()
      else root.toggle()
    }

    // Card behind the modules, like the macOS status item.
    Rectangle {
      id: barCard
      visible: !button.vertical
      anchors.centerIn: parent
      width: barRow.implicitWidth + Style.space(12)
      height: barRow.implicitHeight + Style.space(6)
      radius: Style.space(6)
      color: Qt.alpha(root.barForeground, 0.10)

      Row {
        id: barRow
        anchors.centerIn: parent
        spacing: Style.space(6)

        Repeater {
          model: root.barModules

          Row {
            id: moduleRow
            required property string modelData
            required property int index
            spacing: Style.space(4)

            Rectangle {
              visible: moduleRow.index > 0
              width: 1
              height: Style.space(14)
              color: Qt.alpha(root.barForeground, 0.45)
              anchors.verticalCenter: parent.verticalCenter
            }

            Text {
              textFormat: Text.PlainText
              text: root.moduleLabel(moduleRow.modelData)
              color: root.moduleAccent(moduleRow.modelData)
              font.family: root.fontFamily
              font.pixelSize: Style.space(11)
              font.weight: Font.DemiBold
              anchors.verticalCenter: parent.verticalCenter
            }

            // Fixed to the width of "100%" so a changing value never moves the bar.
            Text {
              width: widest.implicitWidth
              horizontalAlignment: Text.AlignRight
              textFormat: Text.PlainText
              text: root.moduleValue(moduleRow.modelData)
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.space(11)
              anchors.verticalCenter: parent.verticalCenter
            }

            Sparkline {
              width: Style.space(40)
              height: Style.space(14)
              samples: root.moduleSamples(moduleRow.modelData)
              capacity: Model.BAR_SAMPLES
              color: root.moduleAccent(moduleRow.modelData)
              anchors.verticalCenter: parent.verticalCenter
            }
          }
        }
      }
    }

    Text {
      id: widest
      visible: false
      textFormat: Text.PlainText
      text: "100%"
      font.family: root.fontFamily
      font.pixelSize: Style.space(11)
    }

    // Vertical bar: label over value per module.
    Column {
      id: barColumn
      visible: button.vertical
      anchors.centerIn: parent
      spacing: Style.space(6)

      Repeater {
        model: root.barModules

        Column {
          required property string modelData
          spacing: Style.space(1)

          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            textFormat: Text.PlainText
            text: root.moduleLabel(parent.modelData)
            color: root.moduleAccent(parent.modelData)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.weight: Font.DemiBold
          }

          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            textFormat: Text.PlainText
            text: root.moduleValue(parent.modelData)
            color: root.barForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }

  // --- panel -----------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    padding: 0
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(cards.implicitHeight + Style.space(24))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: root.pal.panelBackground

        // Scrolls only when the cards do not fit the screen.
        Flickable {
          anchors.fill: parent
          anchors.margins: Style.space(12)
          contentHeight: cards.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height

          Column {
            id: cards
            width: parent.width
            spacing: Style.space(12)

            Row {
              width: cards.width
              spacing: Style.space(8)

              Rectangle {
                id: btopButton
                width: cards.width - settingsButton.width - parent.spacing
                height: btopLabel.implicitHeight + Style.space(20)
                radius: Style.space(12)
                color: btopMouse.containsMouse ? Qt.alpha(root.pal.textPrimary, 0.10) : root.pal.cardBackground

                Row {
                  anchors.centerIn: parent
                  spacing: Style.space(6)

                  Text {
                    textFormat: Text.PlainText
                    text: Model.glyphs.activity
                    color: root.pal.cpuAccent
                    font.family: root.fontFamily
                    font.pixelSize: Style.space(15)
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: btopLabel
                    textFormat: Text.PlainText
                    text: "Open btop"
                    color: root.pal.textPrimary
                    font.family: root.fontFamily
                    font.pixelSize: Style.space(13)
                    font.weight: Font.DemiBold
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                MouseArea {
                  id: btopMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.openBtop()
                }
              }

              Rectangle {
                id: settingsButton
                width: height
                height: btopButton.height
                radius: Style.space(12)
                color: settingsMouse.containsMouse || root.settingsOpen ? Qt.alpha(root.pal.textPrimary, 0.10) : root.pal.cardBackground

                Text {
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: Model.glyphs.settings
                  color: root.settingsOpen ? root.pal.cpuAccent : root.pal.textPrimary
                  font.family: root.fontFamily
                  font.pixelSize: Style.space(15)
                }

                MouseArea {
                  id: settingsMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    root.settingsStatus = ""
                    root.settingsOpen = !root.settingsOpen
                  }
                }
              }
            }

            SettingsCard { width: cards.width; visible: root.settingsOpen }
            CpuCard { width: cards.width; visible: !root.settingsOpen }
            GpuCard { width: cards.width; visible: !root.settingsOpen && root.hasGpu }
            MemoryCard { width: cards.width; visible: !root.settingsOpen }
            DiskCard { width: cards.width; visible: !root.settingsOpen }
            NetworkCard { width: cards.width; visible: !root.settingsOpen }
          }
        }
      }
    }
  }

  // --- cards -----------------------------------------------------------------

  component Card: Rectangle {
    id: card
    default property alias content: body.data
    implicitHeight: body.implicitHeight + Style.space(32)
    radius: Style.space(12)
    color: root.pal.cardBackground

    Column {
      id: body
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(16)
      spacing: Style.space(14)
    }
  }

  component CardHeader: Row {
    id: header
    property string glyph: ""
    property string title: ""
    property string detail: ""
    property color accent: "white"
    spacing: Style.space(6)

    Text {
      textFormat: Text.PlainText
      text: parent.glyph
      color: parent.accent
      font.family: root.fontFamily
      font.pixelSize: Style.space(15)
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      textFormat: Text.PlainText
      id: headerTitle
      text: parent.title
      color: root.pal.textPrimary
      font.family: root.fontFamily
      font.pixelSize: Style.space(13)
      font.weight: Font.DemiBold
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      visible: header.detail !== ""
      width: Math.min(implicitWidth, header.width - headerTitle.x - headerTitle.width - header.spacing)
      textFormat: Text.PlainText
      text: header.detail
      elide: Text.ElideRight
      color: root.pal.textSecondary
      font.family: root.fontFamily
      font.pixelSize: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  component KeyValueRow: Item {
    property string key: ""
    property string value: ""
    property color valueColor: root.pal.textPrimary
    implicitHeight: keyText.implicitHeight

    Text {
      id: keyText
      anchors.left: parent.left
      textFormat: Text.PlainText
      text: parent.key
      color: root.pal.textSecondary
      font.family: root.fontFamily
      font.pixelSize: Style.space(12)
    }

    Text {
      anchors.right: parent.right
      textFormat: Text.PlainText
      text: parent.value
      color: parent.valueColor
      font.family: root.fontFamily
      font.pixelSize: Style.space(12)
    }
  }

  // Ring on the left, key/value rows filling the rest.
  component GaugeAndRows: Row {
    id: gaugeRow
    property real fraction: 0
    property color accent: "white"
    property string valueText: ""
    property string subtitle: ""
    property var rows: []
    spacing: Style.space(14)

    RingGauge {
      id: gauge
      fraction: gaugeRow.fraction
      color: gaugeRow.accent
      valueText: gaugeRow.valueText
      subtitle: gaugeRow.subtitle
      fontFamily: root.fontFamily
      textColor: root.pal.textPrimary
      subtitleColor: root.pal.textSecondary
    }

    Column {
      width: gaugeRow.width - gauge.width - gaugeRow.spacing
      spacing: Style.space(6)

      Repeater {
        model: gaugeRow.rows
        KeyValueRow {
          required property var modelData
          width: parent.width
          key: modelData.key
          value: modelData.value
          valueColor: modelData.color || root.pal.textPrimary
        }
      }
    }
  }

  component ThroughputLabel: Row {
    property string glyph: ""
    property color accent: "white"
    property string text: ""
    spacing: Style.space(4)

    Text {
      textFormat: Text.PlainText
      text: parent.glyph
      color: parent.accent
      font.family: root.fontFamily
      font.pixelSize: Style.space(13)
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      textFormat: Text.PlainText
      text: parent.text
      color: root.pal.textPrimary
      font.family: root.fontFamily
      font.pixelSize: Style.space(12)
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  // Vertical per-core bars, eight to a row (Components/CoreBarGrid.swift).
  component CoreBarGrid: Column {
    id: grid
    property string title: ""
    property var cores: []
    property color accent: "white"
    readonly property real barWidth: (width - Style.space(4) * (Model.CORES_PER_ROW - 1)) / Model.CORES_PER_ROW
    spacing: Style.space(6)

    Text {
      textFormat: Text.PlainText
      text: grid.title
      color: root.pal.textSecondary
      font.family: root.fontFamily
      font.pixelSize: Style.space(10)
      font.weight: Font.DemiBold
    }

    Repeater {
      model: Model.chunk(grid.cores, Model.CORES_PER_ROW)

      Row {
        required property var modelData
        spacing: Style.space(4)

        Repeater {
          model: parent.modelData

          Column {
            required property var modelData
            width: grid.barWidth
            spacing: Style.space(3)

            Rectangle {
              width: parent.width
              height: Style.space(34)
              radius: Style.space(2)
              color: Qt.alpha(grid.accent, 0.18)

              Rectangle {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: parent.height * Math.max(0, Math.min(1, modelData.usage))
                radius: parent.radius
                color: grid.accent
                Behavior on height { NumberAnimation { duration: 250; easing.type: Easing.OutCubic } }
              }
            }

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              textFormat: Text.PlainText
              text: Model.percentInt(modelData.usage)
              color: root.pal.textSecondary
              font.family: root.fontFamily
              font.pixelSize: Style.space(9)
            }
          }
        }
      }
    }
  }

  component SettingsCard: Card {
    CardHeader { width: parent.width; glyph: Model.glyphs.settings; title: "Bar"; detail: "Modules shown in the bar"; accent: root.pal.cpuAccent }

    Repeater {
      model: Model.barSwitches(root.settings, root.hasGpu)

      Item {
        required property var modelData
        width: parent.width
        height: Math.max(switchLabel.implicitHeight, toggle.height)
        opacity: modelData.enabled ? 1 : 0.5

        Column {
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          Text {
            id: switchLabel
            textFormat: Text.PlainText
            text: modelData.label
            color: root.pal.textPrimary
            font.family: root.fontFamily
            font.pixelSize: Style.space(13)
          }

          Text {
            visible: modelData.note !== ""
            textFormat: Text.PlainText
            text: modelData.note
            color: root.pal.textSecondary
            font.family: root.fontFamily
            font.pixelSize: Style.space(11)
          }
        }

        ToggleSwitch {
          id: toggle
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          checked: modelData.checked
          interactive: modelData.enabled
          foreground: root.pal.textPrimary
          accent: root.pal.cpuAccent
          onToggled: root.setBarSwitch(modelData.key, !modelData.checked)
        }
      }
    }

    Text {
      visible: root.settingsStatus !== ""
      width: parent.width
      wrapMode: Text.Wrap
      textFormat: Text.PlainText
      text: root.settingsStatus
      color: Commons.Color.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.space(11)
    }
  }

  component CpuCard: Card {
    CardHeader { width: parent.width; glyph: Model.glyphs.cpu; title: "CPU"; detail: root.cpuName; accent: root.pal.cpuAccent }

    GaugeAndRows {
      width: parent.width
      fraction: root.cpu ? root.cpu.total : 0
      accent: root.pal.cpuAccent
      valueText: Model.percent1(root.cpu ? root.cpu.total : 0, root.dp)
      subtitle: "CPU"
      rows: Model.cpuRows(root.cpu, root.dp, root.pal, root.cpuTemperature)
    }

    HistoryGraph {
      baselineColor: root.pal.textSecondary
      width: parent.width
      height: Style.space(48)
      series: [{ samples: root.cpuHistory, color: root.pal.cpuAccent, fillOpacity: 0.35 }]
    }

    Repeater {
      model: Model.coreGroups(root.cpu ? root.cpu.cores : [], root.pal)
      CoreBarGrid {
        required property var modelData
        width: parent.width
        title: modelData.title
        cores: modelData.cores
        accent: modelData.color
      }
    }
  }

  component GpuCard: Card {
    CardHeader { width: parent.width; glyph: Model.glyphs.gpu; title: "GPU"; detail: root.gpuName; accent: root.pal.gpuAccent }

    GaugeAndRows {
      width: parent.width
      fraction: root.moduleFraction("gpu")
      accent: root.pal.gpuAccent
      valueText: Model.gpuLoadText(root.gpu, root.dp, false)
      subtitle: "GPU"
      rows: Model.gpuRows(root.gpu, root.dp, root.pal)
    }

    Repeater {
      model: Model.gpuMemory(root.gpu, root.dp, root.pal)

      Column {
        required property var modelData
        width: parent.width
        spacing: Style.space(6)

        KeyValueRow {
          width: parent.width
          key: modelData.key
          value: modelData.value
        }

        StackedBar {
          width: parent.width
          height: Style.space(6)
          segments: [{ fraction: modelData.fraction, color: modelData.color }]
          trackColor: root.pal.textSecondary
        }
      }
    }

    HistoryGraph {
      visible: root.gpuHistory.length > 0
      baselineColor: root.pal.textSecondary
      width: parent.width
      height: Style.space(48)
      series: [{ samples: root.gpuHistory, color: root.pal.gpuAccent, fillOpacity: 0.35 }]
    }
  }

  component MemoryCard: Card {
    CardHeader { glyph: Model.glyphs.memory; title: "Memory"; accent: root.pal.memAccent }

    GaugeAndRows {
      width: parent.width
      fraction: root.memory ? root.memory.fraction : 0
      accent: root.pal.memAccent
      valueText: Model.percent1(root.memory ? root.memory.fraction : 0, root.dp)
      subtitle: "RAM"
      rows: Model.memoryRows(root.memory, root.dp)
    }

    StackedBar {
      width: parent.width
      height: Style.space(8)
      segments: Model.memorySegments(root.memory, root.pal)
      trackColor: root.pal.textSecondary
    }

    Flow {
      width: parent.width
      spacing: Style.space(10)

      Repeater {
        model: Model.memoryLegend(root.pal)

        Row {
          required property var modelData
          spacing: Style.space(4)

          Rectangle {
            width: Style.space(8)
            height: Style.space(8)
            radius: width / 2
            color: modelData.color
            anchors.verticalCenter: parent.verticalCenter
          }

          Text {
            textFormat: Text.PlainText
            text: modelData.label
            color: root.pal.textSecondary
            font.family: root.fontFamily
            font.pixelSize: Style.space(11)
            anchors.verticalCenter: parent.verticalCenter
          }
        }
      }
    }

    HistoryGraph {
      baselineColor: root.pal.textSecondary
      width: parent.width
      height: Style.space(48)
      series: [{ samples: root.memoryHistory, color: root.pal.memAccent, fillOpacity: 0.35 }]
    }
  }

  component DiskCard: Card {
    CardHeader { glyph: Model.glyphs.disk; title: "Disk"; accent: root.pal.diskAccent }

    GaugeAndRows {
      width: parent.width
      fraction: root.disk ? root.disk.fraction : 0
      accent: root.pal.diskAccent
      valueText: root.disk ? Model.percent1(root.disk.fraction, root.dp) : Model.UNAVAILABLE
      subtitle: "Disk"
      rows: Model.diskRows(root.disk, root.dp)
    }

    Row {
      spacing: Style.space(16)

      ThroughputLabel {
        glyph: Model.glyphs.read
        accent: root.pal.diskAccent
        text: root.diskRatesKnown ? Model.throughput(root.diskRead, root.dp) : Model.UNAVAILABLE
      }

      ThroughputLabel {
        glyph: Model.glyphs.write
        accent: root.pal.diskAccent
        text: root.diskRatesKnown ? Model.throughput(root.diskWrite, root.dp) : Model.UNAVAILABLE
      }
    }
  }

  component NetworkCard: Card {
    CardHeader { glyph: Model.glyphs.network; title: "Network"; accent: root.pal.networkAccent }

    Row {
      id: netRow
      width: parent.width
      spacing: Style.space(14)

      Column {
        id: rates
        spacing: Style.space(6)

        ThroughputLabel {
          glyph: Model.glyphs.download
          accent: root.pal.networkDownload
          text: root.network ? Model.throughput(root.network.download, root.dp) : Model.UNAVAILABLE
        }

        ThroughputLabel {
          glyph: Model.glyphs.upload
          accent: root.pal.networkUpload
          text: root.network ? Model.throughput(root.network.upload, root.dp) : Model.UNAVAILABLE
        }
      }

      Column {
        width: netRow.width - rates.width - netRow.spacing
        spacing: Style.space(6)

        Repeater {
          model: Model.networkRows(root.network, root.dp)
          KeyValueRow {
            required property var modelData
            width: parent.width
            key: modelData.key
            value: modelData.value
          }
        }
      }
    }

    HistoryGraph {
      baselineColor: root.pal.textSecondary
      readonly property real scale: Model.networkScale(root.downloadHistory, root.uploadHistory)
      width: parent.width
      height: Style.space(48)
      series: [
        { samples: Model.normalise(root.downloadHistory, scale), color: root.pal.networkDownload, fillOpacity: 0 },
        { samples: Model.normalise(root.uploadHistory, scale), color: root.pal.networkUpload, fillOpacity: 0 }
      ]
    }
  }
}
