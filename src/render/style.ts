/** Tiny ANSI helpers. Colour only on a TTY and only when NO_COLOR is not set. */
const enabled = (): boolean => Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb'

const wrap = (open: number, close: number) => (text: string) => (enabled() ? `\u001B[${open}m${text}\u001B[${close}m` : text)

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[\d+m/g

export function visibleLength(text: string): number {
  return text.replace(ANSI, '').length
}

/** Renders rows as an aligned plain-text table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))))
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c + ' '.repeat(widths[i] - visibleLength(c))))
      .join('  ')
      .trimEnd()
  return [line(headers.map((h) => style.bold(h))), ...rows.map(line)].join('\n')
}
