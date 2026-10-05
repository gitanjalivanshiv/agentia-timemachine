#!/usr/bin/env node
// Runs the plugin's commands without the agentia host (offline demo, CI smoke tests):
//   ./bin/run.js timemachine status
// Inside Copado's CLI, use `agentia plugins link .` and `agentia timemachine …` instead.
import {execute} from '@oclif/core'

await execute({dir: import.meta.url})
