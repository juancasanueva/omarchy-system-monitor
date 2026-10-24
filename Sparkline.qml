import QtQuick
import "Model.js" as Model

// Filled line of one series, newest sample on the right edge
// (Components/Sparkline.swift). Samples are fractions in 0...1.
Canvas {
  id: root

  property var samples: []
  property int capacity: Model.BAR_SAMPLES
  property color color: "white"
  property real fillOpacity: 0.35
  property real lineWidth: 1

  onSamplesChanged: requestPaint()
  onColorChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    var points = Model.sparklinePoints(root.samples, root.capacity, width, height)
    if (points.length === 0) return

    if (root.fillOpacity > 0) {
      ctx.beginPath()
      ctx.moveTo(points[0].x, height)
      for (var i = 0; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
      ctx.lineTo(points[points.length - 1].x, height)
      ctx.closePath()
      ctx.fillStyle = Qt.rgba(root.color.r, root.color.g, root.color.b, root.fillOpacity)
      ctx.fill()
    }

    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (var j = 1; j < points.length; j++) ctx.lineTo(points[j].x, points[j].y)
    ctx.strokeStyle = root.color
    ctx.lineWidth = root.lineWidth
    ctx.lineJoin = "round"
    ctx.stroke()
  }
}
