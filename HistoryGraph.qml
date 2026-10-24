import QtQuick
import "Model.js" as Model

// Card history graph (Components/HistoryGraph.swift): one or more series over
// a faint baseline. Each series is { samples, color, fillOpacity }.
Item {
  id: root

  property var series: []
  property int capacity: Model.GRAPH_SAMPLES
  property color baselineColor: "gray"

  Rectangle {
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: 1
    color: Qt.alpha(root.baselineColor, 0.25)
  }

  Repeater {
    model: root.series

    Sparkline {
      required property var modelData
      anchors.fill: parent
      samples: modelData.samples
      capacity: root.capacity
      color: modelData.color
      fillOpacity: modelData.fillOpacity
    }
  }
}
