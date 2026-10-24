import QtQuick
import "Model.js" as Model

// Horizontal bar of adjacent segments inside a rounded track
// (Components/StackedBar.swift). Segments are { fraction, color }.
Canvas {
  id: root

  property var segments: []

  onSegmentsChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    if (width <= 0 || height <= 0) return
    var r = height / 2

    ctx.beginPath()
    ctx.roundedRect(0, 0, width, height, r, r)
    ctx.clip()

    var track = Model.palette.textSecondary
    ctx.fillStyle = Qt.alpha(track, 0.18)
    ctx.fillRect(0, 0, width, height)

    var x = 0
    for (var i = 0; i < root.segments.length; i++) {
      var w = width * Math.max(0, Math.min(1, root.segments[i].fraction))
      if (w <= 0) continue
      ctx.fillStyle = root.segments[i].color
      ctx.fillRect(x, 0, Math.min(w, width - x), height)
      x += w
    }
  }
}
