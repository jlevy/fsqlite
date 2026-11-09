// Shared measurement settings and helpers for the sizing benchmarks, so both report the
// same statistics and environment fields.

import { arch, cpus, platform, release } from 'node:os'

/** Payload size of each benchmark row. */
export const ROW_BYTES = 2048
/** Captures run and discarded before measuring, so warm caches do not skew the median. */
export const WARMUP_CAPTURES = 5
/** Captures measured per sample. */
export const MEASURED_CAPTURES = 30
/** The caller schema version every benchmark store uses. */
export const BENCHMARK_SCHEMA_VERSION = 1
export const MEDIAN_PERCENTILE = 0.5
export const P95_PERCENTILE = 0.95

/** Milliseconds since `started`, a `process.hrtime.bigint()` reading. */
export function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6
}

/** The nearest-rank percentile of `samples` (`fraction` from 0 to 1). */
export function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0
}

/** The host facts every benchmark report carries, since its numbers are host-specific. */
export function benchmarkEnvironment(): Record<string, string> {
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
  }
}
