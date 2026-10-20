/**
 * Minimal SVG bar-chart renderer — hand-rolled to keep the benchmark
 * dependency-free. Two chart shapes cover the four benchmark views:
 *
 *   hbarChart: horizontal bars (accuracy tables)
 *   vbarChart: vertical bars   (cost, latency)
 *
 * Output is a standalone SVG string with an explicit white background so
 * it reads correctly on GitHub in both light and dark themes.
 */

export interface Bar {
  label: string
  /** Numeric value used for scaling. */
  value: number
  /** Pre-formatted text printed next to the bar (defaults to value). */
  display?: string
  /** Optional caption under the label (vertical) / after it (horizontal). */
  note?: string
  color?: string
}

export interface ChartOptions {
  title: string
  subtitle?: string
  unit?: string
  bars: readonly Bar[]
  /** Upper bound of the value axis; defaults to the largest bar. */
  maxValue?: number
  width?: number
}

const FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif"
const INK = "#0f172a"
const MUTED = "#64748b"
const AXIS = "#cbd5e1"
const BG = "#ffffff"
const DEFAULT_COLOR = "#3b82f6"
const HIGHLIGHT = "#0f766e"

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

function header(o: ChartOptions, height: number): string {
  const parts = [
    `<rect x="0" y="0" width="${o.width ?? 820}" height="${height}" fill="${BG}"/>`,
    `<text x="24" y="34" font-family="${FONT}" font-size="17" font-weight="600" fill="${INK}">${esc(o.title)}</text>`,
  ]
  if (o.subtitle) {
    parts.push(
      `<text x="24" y="54" font-family="${FONT}" font-size="12" fill="${MUTED}">${esc(o.subtitle)}</text>`,
    )
  }
  return parts.join("")
}

/** Horizontal bar chart. First bar is treated as the summary row. */
export function hbarChart(o: ChartOptions): string {
  const width = o.width ?? 820
  const labelCol = 210
  const rowH = 36
  const top = o.subtitle ? 70 : 56
  const height = top + o.bars.length * rowH + 16
  const max = o.maxValue ?? Math.max(...o.bars.map((b) => b.value), 1e-9)
  const barMax = width - labelCol - 120

  const rows = o.bars
    .map((bar, i) => {
      const y = top + i * rowH
      const w = Math.max(2, (bar.value / max) * barMax)
      const color = bar.color ?? (i === 0 ? HIGHLIGHT : DEFAULT_COLOR)
      const display = bar.display ?? fmt(bar.value)
      const label = bar.note ? `${bar.label} (${esc(bar.note)})` : bar.label
      return (
        `<text x="${labelCol - 12}" y="${y + 19}" text-anchor="end" font-family="${FONT}" ` +
        `font-size="13" fill="${INK}">${esc(label)}</text>` +
        `<rect x="${labelCol}" y="${y + 6}" width="${w}" height="20" rx="3" fill="${color}"/>` +
        `<text x="${labelCol + w + 8}" y="${y + 21}" font-family="${FONT}" font-size="13" ` +
        `font-weight="${i === 0 ? "600" : "400"}" fill="${INK}">${esc(display)}</text>`
      )
    })
    .join("")

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    header(o, height) +
    `<line x1="${labelCol}" y1="${top - 6}" x2="${labelCol}" y2="${height - 10}" stroke="${AXIS}"/>` +
    rows +
    `</svg>`
  )
}

/** Vertical bar chart with the value on top and the label beneath. */
export function vbarChart(o: ChartOptions): string {
  const width = o.width ?? 820
  const top = o.subtitle ? 80 : 64
  const plotH = 240
  const colW = Math.floor((width - 48) / o.bars.length)
  const barW = Math.min(96, Math.floor(colW * 0.6))
  const bottom = top + plotH
  const height = bottom + 64
  const max = o.maxValue ?? Math.max(...o.bars.map((b) => b.value), 1e-9)

  const cols = o.bars
    .map((bar, i) => {
      const h = Math.max(3, Math.round((bar.value / max) * plotH))
      const cx = 24 + colW * i + Math.floor(colW / 2)
      const x = cx - Math.floor(barW / 2)
      const display = bar.display ?? fmt(bar.value)
      const labelLines = wrap(bar.label, 18)
      const noteLines = bar.note ? wrap(bar.note, 22) : []
      const labelStart = bottom + 40 + (noteLines.length > 0 ? 0 : 0)
      let svg =
        `<rect x="${x}" y="${bottom - h}" width="${barW}" height="${h}" rx="3" fill="${bar.color ?? DEFAULT_COLOR}"/>` +
        `<text x="${cx}" y="${bottom - h - 8}" text-anchor="middle" font-family="${FONT}" ` +
        `font-size="13" font-weight="600" fill="${INK}">${esc(display)}</text>`
      labelLines.forEach((line, li) => {
        svg +=
          `<text x="${cx}" y="${labelStart + li * 15}" text-anchor="middle" ` +
          `font-family="${FONT}" font-size="12" fill="${INK}">${esc(line)}</text>`
      })
      noteLines.forEach((line, li) => {
        svg +=
          `<text x="${cx}" y="${labelStart + labelLines.length * 15 + 6 + li * 14}" ` +
          `text-anchor="middle" font-family="${FONT}" font-size="10" fill="${MUTED}">${esc(line)}</text>`
      })
      return svg
    })
    .join("")

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    header(o, height) +
    `<line x1="24" y1="${bottom}" x2="${width - 24}" y2="${bottom}" stroke="${AXIS}"/>` +
    (o.unit
      ? `<text x="${width - 24}" y="${top - 10}" text-anchor="end" font-family="${FONT}" ` +
        `font-size="12" fill="${MUTED}">${esc(o.unit)}</text>`
      : "") +
    cols +
    `</svg>`
  )
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (current.length === 0) current = word
    else if (`${current} ${word}`.length <= maxChars) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 3)
}
