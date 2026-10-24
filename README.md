# System Monitor

CPU, GPU and memory with live sparklines in the Omarchy bar, and a panel with CPU, GPU, Memory, Disk and Network cards. A port of the macOS menu bar app [SWIFTUI_system_monitor](https://github.com/juancasanueva/SWIFTUI_system_monitor), with the same layout and number formats, coloured by your current Omarchy theme.

<p align="center"><img src="preview.png?v=5" alt="System Monitor panel: CPU, GPU and Memory cards" width="360"></p>

## What it shows

- **Bar**: `CPU 12% ▁▂▃` `|` `GPU 16% ▁▁▂` `|` `MEM 59% ▃▃▄` on a small card. The GPU module appears only on AMD GPUs. Each value has a fixed width, so the bar never shifts. The last 60 samples feed each sparkline.
- **CPU**: the CPU's model in the header, total usage ring, User, System and package temperature, a two-minute history graph, and one bar per logical core. On Intel hybrid CPUs, P-Cores and E-Cores are shown as separate groups with their own averages.
- **GPU**: the GPU's name in the header, load ring, temperature, power draw and core clock (plus memory busy, memory clock and voltage where the GPU reports them), VRAM and shared memory with a usage bar each, and a history graph. AMD GPUs (`amdgpu` driver) only; the card is hidden on other GPUs.
- **Memory**: usage ring, Used, Total, Wired and Compressed, a stacked bar (App, Wired, Compressed, Cached, Free) with its legend, and a history graph.
- **Disk**: usage ring for `/`, Used, Free and Total, and read and write throughput.
- **Network**: download and upload rates, totals since boot, and a shared-scale graph of both.
- **Settings**: the gear next to **Open btop** switches the panel to the bar settings, where CPU, GPU and MEM can each be shown or hidden. Changes apply right away and are saved in `shell.json`.
- **btop**: right-click the widget, or use **Open btop** at the top of the panel, to open btop in your terminal as a tiled window. If btop is already open from the widget, its window is focused instead. It uses Omarchy's TUI launcher with its own app id (`io.github.juancasanueva.btop`), so Omarchy's float rule for Super+Ctrl+T btop does not apply.

When the cards do not fit the screen, the panel scrolls. The widget samples every 2 seconds, or every second while the panel is open. Disk capacity refreshes every 30 seconds and whenever the panel opens.

## Colours

Every colour comes from the current Omarchy theme and changes with it when you switch themes. The panel, cards and text use the theme's popup colours. Each metric keeps the role it has in the macOS app, using an ANSI colour from the theme's `colors.toml`:

| Role | Theme colour |
| --- | --- |
| CPU, Cached, Upload | blue |
| E-Cores, GPU | cyan |
| Memory, App | yellow |
| Wired | red |
| Compressed, Network | magenta |
| Disk, Free, Download | green |

If a theme defines none of these, its accent colour is used (and its urgent colour for Wired).

## How the numbers map to Linux

| Card value | Source |
| --- | --- |
| CPU name | First `model name` in `/proc/cpuinfo`, without trademarks, clock speed, core count or integrated graphics |
| CPU total, User, System | `/proc/stat` deltas. Busy is everything except idle and iowait. User includes nice. System includes irq and softirq. |
| Temperature | `temp1_input` of the first `/sys/class/hwmon` sensor whose driver is `k10temp`, `zenpower`, `coretemp` or `cpu_thermal`. The row is hidden when none is found. |
| P-Cores / E-Cores | `/sys/devices/cpu_core/cpus` and `/sys/devices/cpu_atom/cpus`. If they are missing, all cores are shown in one "Cores" group. |
| GPU name | amdgpu's `product_name` (dedicated cards), otherwise the device's entry in `/usr/share/hwdata/pci.ids`, read once at startup |
| GPU load, Memory busy | `gpu_busy_percent` and `mem_busy_percent` of the first `/sys/class/drm/card*/device` that has them |
| VRAM, Shared | `mem_info_vram_{used,total}` and `mem_info_gtt_{used,total}`. Shared is GTT: system RAM the GPU maps, which is most of its memory on an integrated GPU. |
| GPU Temperature, Power, clocks, Voltage | The card's own `amdgpu` hwmon: `temp1_input` (edge), `power1_average` or `power1_input`, `freq1_input` (core) and `freq2_input` (memory), `in0_input` (vddgfx). Rows without a reading are hidden. |
| Memory Used | `MemTotal - MemAvailable` |
| App | `AnonPages + Shmem` |
| Wired | `SUnreclaim + KernelStack + PageTables` (kernel memory that cannot be reclaimed) |
| Compressed | `Zswap` plus the RAM used by `zram0` (`mm_stat` mem_used_total) |
| Cached | `Buffers + Cached + SReclaimable - Shmem` |
| Disk capacity | `df -B1 --output=size,used,avail -- /`. Used is Total - Free, like the macOS card. |
| Disk throughput | `/proc/diskstats`, whole disks only (no partitions, dm, loop or zram) |
| Network | `/proc/net/dev`, without loopback and virtual links (bridges, containers, VPN tunnels) |

## Install

```sh
omarchy plugin add https://github.com/juancasanueva/omarchy-system-monitor.git --enable
```

Settings: click the gear next to **Open btop** in the panel and switch CPU, GPU and MEM on or off for the bar. The last module on the bar cannot be switched off, so the widget never disappears. The same keys can be set in the widget's `shell.json` entry or under Setup > Bar:

| Key | Default | Effect |
| --- | --- | --- |
| `showCpu` | `true` | Show the CPU module in the bar |
| `showMemory` | `true` | Show the MEM module in the bar |
| `showGpu` | `true` | Show the GPU module in the bar (AMD GPUs only; it never appears without one) |

Click the widget, or run `omarchy-shell juancasanueva.system-monitor toggle`, to open the panel. Esc closes it. Right-click the widget to open btop.

## Privacy and side effects

The plugin only reads kernel files under `/proc` and `/sys`, the PCI ID database `/usr/share/hwdata/pci.ids`, the current theme's `colors.toml`, and runs `/usr/bin/df` with a fixed argument list. Opening btop runs `/usr/bin/omarchy-launch-or-focus-tui --app-id=io.github.juancasanueva.btop btop`, which ships with Omarchy, and only when you ask for it. It makes no network requests and writes no files of its own. The settings switches save through the shell's own settings API, which rewrites only this widget's entry in `shell.json`. History lives in memory and resets when the shell restarts.

## Removing

```sh
omarchy plugin remove juancasanueva.system-monitor
```

Nothing persists after removal.

## Development

```sh
node tests/test_model.cjs        # parsers, arithmetic and formatters
omarchy plugin validate .
```

## License

MIT
