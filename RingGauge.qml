import QtQuick
import qs.Commons

// Ring gauge with the value and a caption in the middle
// (Components/RingGauge.swift): 84 px across, 8 px stroke, faint track.
Item {
  id: root

  property real fraction: 0
  property color color: "white"
  property string valueText: ""
  property string subtitle: ""
  property string fontFamily: Style.font.family
  property color textColor: "white"
  property color subtitleColor: "gray"

  readonly property real lineWidth: Style.space(8)
  property real shownFraction: Math.max(0, Math.min(1, isFinite(fraction) ? fraction : 0))

  implicitWidth: Style.space(84)
  implicitHeight: Style.space(84)

  Behavior on shownFraction { NumberAnimation { duration: 250; easing.type: Easing.OutCubic } }

  onShownFractionChanged: ring.requestPaint()
  onColorChanged: ring.requestPaint()

  Canvas {
    id: ring
    anchors.fill: parent
    onWidthChanged: requestPaint()

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var r = (Math.min(width, height) - root.lineWidth) / 2
      var cx = width / 2
      var cy = height / 2
      ctx.lineWidth = root.lineWidth

      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2, false)
      ctx.strokeStyle = Qt.rgba(root.color.r, root.color.g, root.color.b, 0.18)
      ctx.stroke()

      if (root.shownFraction <= 0) return
      var start = -Math.PI / 2
      ctx.beginPath()
      ctx.arc(cx, cy, r, start, start + Math.PI * 2 * root.shownFraction, false)
      ctx.lineCap = "round"
      ctx.strokeStyle = root.color
      ctx.stroke()
    }
  }

  Column {
    anchors.centerIn: parent
    spacing: Style.space(2)

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      textFormat: Text.PlainText
      text: root.valueText
      color: root.textColor
      font.family: root.fontFamily
      font.pixelSize: Style.space(16)
      font.bold: true
    }

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      textFormat: Text.PlainText
      text: root.subtitle
      color: root.subtitleColor
      font.family: root.fontFamily
      font.pixelSize: Style.space(11)
    }
  }
}
