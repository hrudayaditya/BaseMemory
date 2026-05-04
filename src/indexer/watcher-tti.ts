import { realpathSync } from "fs";
import * as path from "path";

const latestWatcherEventTimestamps = new Map<string, number>();

function normalizeFilePath(filePath: string): string {
  try {
    return realpathSync.native?.(filePath) ?? realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function recordWatcherEventTimestamp(
  filePath: string,
  timestamp: number = Date.now()
): void {
  latestWatcherEventTimestamps.set(normalizeFilePath(filePath), timestamp);
}

export function ensureWatcherEventTimestamp(
  filePath: string,
  timestamp: number = Date.now()
): void {
  const normalizedPath = normalizeFilePath(filePath);
  if (!latestWatcherEventTimestamps.has(normalizedPath)) {
    latestWatcherEventTimestamps.set(normalizedPath, timestamp);
  }
}

export function consumeWatcherEventTimestamp(filePath: string): number | undefined {
  const normalizedPath = normalizeFilePath(filePath);
  const timestamp = latestWatcherEventTimestamps.get(normalizedPath);
  latestWatcherEventTimestamps.delete(normalizedPath);
  return timestamp;
}

export function clearWatcherEventTimestamp(filePath: string): void {
  latestWatcherEventTimestamps.delete(normalizeFilePath(filePath));
}

export function resetWatcherEventTimestamps(): void {
  latestWatcherEventTimestamps.clear();
}
