import readline from 'node:readline/promises'

/** Asks a yes/no question on the terminal (prompt on stderr, so stdout stays clean). Default: no. */
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({input: process.stdin, output: process.stderr})
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY)
}
