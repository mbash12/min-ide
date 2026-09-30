const gutterWidth = 4 // gap between two panes
const minPaneWidth = 100 // minimum width of a pane when resizing
const maxPanesPerGroup = 3 // most panes a single tiled group can hold

/* a new group starts with the width divided evenly */
function evenFractions (count) {
  return new Array(count).fill(1 / count)
}

/* the saved pane widths of a group: one positive entry per pane, normalized to
add up to 1. Anything unusable falls back to an even split. Layouts saved
before a group could hold more than two panes stored a single splitRatio, which
is still read so those layouts keep their divider position. */
function readFractions (group, paneCount) {
  if (Array.isArray(group.fractions) && group.fractions.length === paneCount) {
    const usable = group.fractions.every(f => typeof f === 'number' && isFinite(f) && f > 0)
    if (usable) {
      const total = group.fractions.reduce((a, b) => a + b, 0)
      return group.fractions.map(f => f / total)
    }
  }
  if (paneCount === 2 && typeof group.splitRatio === 'number' && isFinite(group.splitRatio)) {
    const left = Math.min(1, Math.max(0, group.splitRatio))
    return [left, 1 - left]
  }
  return evenFractions(paneCount)
}

function computePaneWidths (group, totalWidth) {
  const count = group.paneTabIds.length
  const available = Math.max(0, totalWidth - gutterWidth * (count - 1))
  const minWidth = Math.min(minPaneWidth, Math.floor(available / count))
  const maxWidth = Math.max(minWidth, available - minWidth * (count - 1))

  const widths = group.fractions.map(fraction => Math.round(available * fraction))
  for (let i = 0; i < count; i++) {
    widths[i] = Math.min(Math.max(widths[i], minWidth), maxWidth)
  }

  // rounding and clamping can leave a few pixels over; hand them back to the
  // panes that still have room
  let remainder = available - widths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < count && remainder !== 0; i++) {
    const target = Math.min(Math.max(widths[i] + remainder, minWidth), maxWidth)
    remainder -= target - widths[i]
    widths[i] = target
  }

  return widths
}

module.exports = { gutterWidth, minPaneWidth, maxPanesPerGroup, evenFractions, readFractions, computePaneWidths }
