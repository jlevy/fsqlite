import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { errorMessage, FsqliteError, StoreFormatError } from './errors.ts'
import { fsyncDir, fsyncPath, removeQuietly } from './fsutil.ts'

export const STORE_MARKER_FILENAME = 'fsqlite.json'
export const STORE_FORMAT_NAME = 'fsqlite'
export const STORE_FORMAT_VERSION = 'f1.0'
export const FSQLITE_APPLICATION_ID = 0x4653514c // ASCII "FSQL" in the SQLite header.

const FORMAT_VERSION_PATTERN = /^f(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const STORE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUPPORTED_REQUIRED_FEATURES: ReadonlySet<string> = new Set()

function isArrayOfNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

export interface StoreMarker {
  format: typeof STORE_FORMAT_NAME
  format_version: typeof STORE_FORMAT_VERSION
  required_features: string[]
  store_id: string
}

export type StoreRecognition =
  | { state: 'not-a-store'; issue: string }
  | { state: 'invalid'; issue: string }
  | { state: 'unsupported'; issue: string }
  | { state: 'supported'; marker: StoreMarker }

export type StoreRecognitionFailure = Exclude<StoreRecognition['state'], 'supported'>

export function storeMarkerPath(storeDir: string): string {
  return join(storeDir, STORE_MARKER_FILENAME)
}

/** Whether a directory declares itself to be an fsqlite store, even if its marker is corrupt. */
export function hasStoreMarker(storeDir: string): boolean {
  return existsSync(storeMarkerPath(storeDir))
}

/** Recognize a path without conflating unsupported metadata with store corruption. */
export function recognizeStore(storeDir: string): StoreRecognition {
  const path = storeMarkerPath(storeDir)
  if (!existsSync(path)) {
    return { state: 'not-a-store', issue: `missing ${STORE_MARKER_FILENAME} store marker` }
  }

  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      state: 'invalid',
      issue: `invalid ${STORE_MARKER_FILENAME}: malformed JSON (${errorMessage(error)})`,
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: 'invalid', issue: `invalid ${STORE_MARKER_FILENAME}: expected a JSON object` }
  }

  const marker = value as Record<string, unknown>
  if (marker.format !== STORE_FORMAT_NAME) {
    return {
      state: 'invalid',
      issue: `invalid ${STORE_MARKER_FILENAME}: format must be ${JSON.stringify(STORE_FORMAT_NAME)}`,
    }
  }
  if (
    typeof marker.format_version !== 'string' ||
    !FORMAT_VERSION_PATTERN.test(marker.format_version)
  ) {
    return {
      state: 'invalid',
      issue: `invalid ${STORE_MARKER_FILENAME}: format_version must match f<major>.<minor>`,
    }
  }
  const requiredFeatures = marker.required_features
  if (!isArrayOfNonEmptyStrings(requiredFeatures)) {
    return {
      state: 'invalid',
      issue: `invalid ${STORE_MARKER_FILENAME}: required_features must be an array of strings`,
    }
  }
  const duplicateFeatures = requiredFeatures.filter(
    (feature, index) => requiredFeatures.indexOf(feature) !== index,
  )
  if (duplicateFeatures.length > 0) {
    return {
      state: 'invalid',
      issue: `invalid ${STORE_MARKER_FILENAME}: required_features contains duplicates`,
    }
  }
  if (typeof marker.store_id !== 'string' || !STORE_ID_PATTERN.test(marker.store_id)) {
    return {
      state: 'invalid',
      issue: `invalid ${STORE_MARKER_FILENAME}: store_id must be a UUID`,
    }
  }
  if (marker.format_version !== STORE_FORMAT_VERSION) {
    return {
      state: 'unsupported',
      issue: `unsupported fsqlite format version ${JSON.stringify(marker.format_version)}`,
    }
  }
  const unsupportedFeature = requiredFeatures.find(
    (feature) => !SUPPORTED_REQUIRED_FEATURES.has(feature),
  )
  if (unsupportedFeature !== undefined) {
    return {
      state: 'unsupported',
      issue: `unsupported required fsqlite feature ${JSON.stringify(unsupportedFeature)}`,
    }
  }

  return {
    state: 'supported',
    marker: {
      format: STORE_FORMAT_NAME,
      format_version: STORE_FORMAT_VERSION,
      required_features: [...requiredFeatures],
      store_id: marker.store_id,
    },
  }
}

/** Read the immutable identity marker or throw a typed recognition error. */
export function readStoreMarker(storeDir: string): StoreMarker {
  const recognition = recognizeStore(storeDir)
  if (recognition.state === 'supported') {
    return recognition.marker
  }
  throw new StoreFormatError(recognition.state, recognition.issue)
}

/** Create and durably publish a new store marker. Call only while holding the publish lock. */
export function createStoreMarker(storeDir: string): StoreMarker {
  const marker: StoreMarker = {
    format: STORE_FORMAT_NAME,
    format_version: STORE_FORMAT_VERSION,
    required_features: [],
    store_id: randomUUID(),
  }
  const path = storeMarkerPath(storeDir)
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' })
    fsyncPath(tmp)
    renameSync(tmp, path)
    fsyncDir(storeDir)
  } catch (error) {
    removeQuietly(tmp)
    throw new FsqliteError('io', `failed to create ${storeMarkerPath(storeDir)}`, { cause: error })
  }
  return marker
}
