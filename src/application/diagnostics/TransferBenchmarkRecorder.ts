import { sha256Hex } from '@/application/media/contentIdentity';
import type {
  AirMeshDataLayer,
  DeviceSettingsRepository,
  JsonValue,
  ResourceKind,
  TransferRecord,
} from '@/data';

export const PREVIEW_BUDGET_MS = 5_000;
export const FIVE_MIB_ORIGINAL_BUDGET_MS = 30_000;

const FIVE_MIB = 5 * 1024 * 1024;
const STORE_KEY = 'diagnostics:transfer-benchmarks:v1';
const STORE_VERSION = 1;
const MAX_RECORDS = 250;
const MAX_EXPORTED_SAMPLES = 20;
const MAX_DATE_MS = 8_640_000_000_000_000;
const TAG_PATTERN = /^[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();

export interface TransferBenchmarkRecord {
  schemaVersion: typeof STORE_VERSION;
  tripTag: string;
  photoTag: string;
  resourceTag: string;
  kind: ResourceKind;
  byteLength: number;
  sourcePublishedAtMs: number | null;
  queuedAtMs: number;
  startedAtMs: number | null;
  firstProgressAtMs: number | null;
  progress25AtMs: number | null;
  progress50AtMs: number | null;
  progress75AtMs: number | null;
  verificationAtMs: number | null;
  verificationInferred: boolean;
  readyAtMs: number | null;
  lastProgressAtMs: number;
  lastProgressBytes: number;
  pauseCount: number;
  lastState: TransferRecord['state'];
}

interface TransferBenchmarkStore {
  schemaVersion: typeof STORE_VERSION;
  records: TransferBenchmarkRecord[];
}

export interface TransferBenchmarkMetric {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  budgetMs: number;
  p50WithinBudget: boolean | null;
  p95WithinBudget: boolean | null;
}

export interface TransferBenchmarkSummary {
  preview: TransferBenchmarkMetric;
  originalFiveMiBEquivalent: TransferBenchmarkMetric;
  incompleteCount: number;
  invalidClockSampleCount: number;
  inferredVerificationSampleCount: number;
}

/**
 * Keeps a small, non-secret performance journal in SQLite-backed settings.
 * Only one-way hashes of identifiers are stored, and resource payloads never
 * enter this recorder.
 */
export class TransferBenchmarkRecorder {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly data: Pick<AirMeshDataLayer, 'repositories'>,
    private readonly now: () => number = Date.now,
  ) {}

  observeTransfer(tripId: string, transferId: string): Promise<void> {
    return this.enqueue(async () => {
      const transfer = await this.data.repositories.transfers.getById(tripId, transferId);
      if (!transfer || transfer.direction !== 'download') return;
      const [resource, store] = await Promise.all([
        this.data.repositories.resources.getById(tripId, transfer.resourceId),
        this.loadStore(),
      ]);
      if (!resource) return;
      const media = await this.data.repositories.media.getById(tripId, resource.mediaId);
      if (!media) return;
      const observedAtMs = checkedTimestamp(this.now());
      const key = `${tag(media.id)}:${resource.kind}`;
      const existing = store.records.find(
        (record) => `${record.photoTag}:${record.kind}` === key,
      );
      const ratio = transfer.totalBytes > 0
        ? transfer.bytesTransferred / transfer.totalBytes
        : transfer.state === 'completed' ? 1 : 0;
      const progressWasObserved = transfer.state === 'transferring' || transfer.state === 'verifying';
      const startedAtMs = transfer.startedAt ?? (
        transfer.bytesTransferred > 0 && progressWasObserved ? observedAtMs : null
      );
      const next: TransferBenchmarkRecord = existing
        ? { ...existing }
        : {
            schemaVersion: STORE_VERSION,
            tripTag: tag(tripId),
            photoTag: tag(media.id),
            resourceTag: tag(resource.id),
            kind: resource.kind,
            byteLength: resource.byteLength,
            sourcePublishedAtMs: media.publishedAtMs,
            queuedAtMs: transfer.createdAt,
            startedAtMs: null,
            firstProgressAtMs: null,
            progress25AtMs: null,
            progress50AtMs: null,
            progress75AtMs: null,
            verificationAtMs: null,
            verificationInferred: false,
            readyAtMs: null,
            lastProgressAtMs: transfer.createdAt,
            lastProgressBytes: 0,
            pauseCount: 0,
            lastState: 'queued',
          };

      next.byteLength = resource.byteLength;
      next.sourcePublishedAtMs ??= media.publishedAtMs;
      next.queuedAtMs = Math.min(next.queuedAtMs, transfer.createdAt);
      next.startedAtMs ??= startedAtMs;
      if (progressWasObserved && transfer.bytesTransferred > 0) {
        next.firstProgressAtMs ??= observedAtMs;
      }
      if (progressWasObserved && ratio >= 0.25) next.progress25AtMs ??= observedAtMs;
      if (progressWasObserved && ratio >= 0.5) next.progress50AtMs ??= observedAtMs;
      if (progressWasObserved && ratio >= 0.75) next.progress75AtMs ??= observedAtMs;
      if (
        transfer.bytesTransferred === transfer.totalBytes &&
        (transfer.state === 'verifying' || transfer.state === 'completed')
      ) {
        if (
          transfer.state === 'verifying' &&
          next.readyAtMs === null &&
          (next.verificationAtMs === null || next.verificationInferred)
        ) {
          next.verificationAtMs = observedAtMs;
          next.verificationInferred = false;
        } else if (transfer.state === 'completed' && next.verificationAtMs === null) {
          next.verificationAtMs = resource.verifiedAtMs ?? transfer.completedAt ?? observedAtMs;
          next.verificationInferred = true;
        }
      }
      const wasReady = next.readyAtMs !== null;
      if (transfer.state === 'completed' && resource.availability === 'available') {
        next.readyAtMs ??= transfer.completedAt ?? resource.verifiedAtMs ?? observedAtMs;
      }
      if (
        transfer.state === 'paused' &&
        next.lastState !== 'paused' &&
        !isTerminalTransferState(next.lastState)
      ) {
        next.pauseCount += 1;
      }
      if (!isTerminalTransferState(next.lastState) || transfer.state === 'completed') {
        next.lastState = transfer.state;
      }
      if (transfer.bytesTransferred > next.lastProgressBytes) {
        next.lastProgressBytes = Math.min(transfer.bytesTransferred, transfer.totalBytes);
        next.lastProgressAtMs = Math.max(next.lastProgressAtMs, observedAtMs);
      } else if (!wasReady && next.readyAtMs !== null) {
        next.lastProgressAtMs = Math.max(next.lastProgressAtMs, observedAtMs);
      }
      upsertRecord(store, next);
      await this.saveStore(store, observedAtMs);
    });
  }

  observeResourceReady(tripId: string, resourceId: string): Promise<void> {
    return this.enqueue(async () => {
      const [resource, transfers, store] = await Promise.all([
        this.data.repositories.resources.getById(tripId, resourceId),
        this.data.repositories.transfers.listRecent(tripId),
        this.loadStore(),
      ]);
      if (!resource) return;
      const transfer = transfers.find(
        (candidate) => candidate.direction === 'download' && candidate.resourceId === resourceId,
      );
      if (!transfer) return;
      const media = await this.data.repositories.media.getById(tripId, resource.mediaId);
      if (!media) return;
      const observedAtMs = checkedTimestamp(this.now());
      const photoTag = tag(media.id);
      const existing = store.records.find(
        (record) => record.photoTag === photoTag && record.kind === resource.kind,
      );
      const readyAtMs = transfer.completedAt ?? resource.verifiedAtMs ?? observedAtMs;
      const next: TransferBenchmarkRecord = existing
        ? { ...existing }
        : {
            schemaVersion: STORE_VERSION,
            tripTag: tag(tripId),
            photoTag,
            resourceTag: tag(resource.id),
            kind: resource.kind,
            byteLength: resource.byteLength,
            sourcePublishedAtMs: media.publishedAtMs,
            queuedAtMs: transfer.createdAt,
            startedAtMs: transfer.startedAt,
            firstProgressAtMs: null,
            progress25AtMs: null,
            progress50AtMs: null,
            progress75AtMs: null,
            verificationAtMs: resource.verifiedAtMs ?? readyAtMs,
            verificationInferred: true,
            readyAtMs: null,
            lastProgressAtMs: observedAtMs,
            lastProgressBytes: transfer.bytesTransferred,
            pauseCount: 0,
            lastState: transfer.state,
          };
      next.sourcePublishedAtMs ??= media.publishedAtMs;
      next.startedAtMs ??= transfer.startedAt;
      if (next.verificationAtMs === null) {
        next.verificationAtMs = resource.verifiedAtMs ?? readyAtMs;
        next.verificationInferred = true;
      }
      next.readyAtMs ??= readyAtMs;
      next.lastProgressBytes = Math.max(next.lastProgressBytes, resource.byteLength);
      next.lastProgressAtMs = Math.max(next.lastProgressAtMs, observedAtMs);
      next.lastState = 'completed';
      upsertRecord(store, next);
      await this.saveStore(store, observedAtMs);
    });
  }

  async buildExport(tripId: string): Promise<string> {
    await this.pending;
    const store = await this.loadStore();
    return buildTransferBenchmarkExport(
      store.records.filter((record) => record.tripTag === tag(tripId)),
      checkedTimestamp(this.now()),
    );
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.pending.then(task);
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async loadStore(): Promise<TransferBenchmarkStore> {
    const setting = await this.settings().get<JsonValue>(STORE_KEY);
    return parseStore(setting?.value);
  }

  private async saveStore(store: TransferBenchmarkStore, updatedAt: number): Promise<void> {
    store.records.sort((left, right) => right.lastProgressAtMs - left.lastProgressAtMs);
    if (store.records.length > MAX_RECORDS) store.records.length = MAX_RECORDS;
    await this.settings().set({
      key: STORE_KEY,
      value: store as unknown as JsonValue,
      updatedAt,
    });
  }

  private settings(): DeviceSettingsRepository {
    return this.data.repositories.deviceSettings;
  }
}

export function summarizeTransferBenchmarks(
  records: readonly TransferBenchmarkRecord[],
): TransferBenchmarkSummary {
  const previewDurations: number[] = [];
  const originalFiveMiBDurations: number[] = [];
  let invalidClockSampleCount = 0;
  let inferredVerificationSampleCount = 0;
  for (const record of records) {
    if (record.kind === 'THUMBNAIL' && record.sourcePublishedAtMs !== null && record.readyAtMs !== null) {
      const timeline = benchmarkTimeline(record, true);
      const duration = record.readyAtMs - record.sourcePublishedAtMs;
      if (isNonDecreasing(timeline) && isSafeDuration(duration)) previewDurations.push(duration);
      else invalidClockSampleCount += 1;
    }
    if (
      record.kind === 'ORIGINAL' &&
      record.startedAtMs !== null &&
      record.verificationAtMs !== null &&
      record.readyAtMs !== null &&
      record.byteLength > 0
    ) {
      if (record.verificationInferred) {
        inferredVerificationSampleCount += 1;
        continue;
      }
      const transferDuration = record.verificationAtMs - record.startedAtMs;
      const verificationDuration = record.readyAtMs - record.verificationAtMs;
      const normalizedDuration = Math.round(
        (transferDuration * FIVE_MIB) / record.byteLength + verificationDuration,
      );
      if (
        isNonDecreasing(benchmarkTimeline(record, false)) &&
        isSafeDuration(transferDuration) &&
        isSafeDuration(verificationDuration) &&
        isSafeDuration(normalizedDuration)
      ) {
        originalFiveMiBDurations.push(normalizedDuration);
      } else {
        invalidClockSampleCount += 1;
      }
    }
  }
  return {
    preview: metric(previewDurations, PREVIEW_BUDGET_MS),
    originalFiveMiBEquivalent: metric(
      originalFiveMiBDurations,
      FIVE_MIB_ORIGINAL_BUDGET_MS,
    ),
    incompleteCount: records.filter((record) => record.readyAtMs === null).length,
    invalidClockSampleCount,
    inferredVerificationSampleCount,
  };
}

export function buildTransferBenchmarkExport(
  records: readonly TransferBenchmarkRecord[],
  generatedAtMs: number,
): string {
  const summary = summarizeTransferBenchmarks(records);
  const recent = [...records]
    .sort((left, right) => right.lastProgressAtMs - left.lastProgressAtMs)
    .slice(0, MAX_EXPORTED_SAMPLES);
  return [
    'CrewRoll transfer benchmark (redacted)',
    `generatedAt=${iso(generatedAtMs)}`,
    metricLine('previewPublishToUsable', summary.preview),
    metricLine('original5MiBEquivalent', summary.originalFiveMiBEquivalent),
    `incomplete=${summary.incompleteCount}; invalidClockSamples=${summary.invalidClockSampleCount}; inferredVerificationSamples=${summary.inferredVerificationSampleCount}`,
    'clock=wall-clock timestamps survive relaunch; preview spans publisher and receiver clocks, so impossible event order is excluded and remaining samples can still reflect clock skew',
    'normalization=5 MiB equivalent scales measured transfer time by byte count and adds measured verification time; completion-bound verification samples are excluded',
    ...recent.map(sampleLine),
  ].join('\n');
}

function sampleLine(record: TransferBenchmarkRecord): string {
  return [
    `sample=${exportTag(record.photoTag)}/${record.kind.toLowerCase()}`,
    `bytes=${record.byteLength}`,
    `published=${iso(record.sourcePublishedAtMs)}`,
    `queued=${iso(record.queuedAtMs)}`,
    `started=${iso(record.startedAtMs)}`,
    `first=${iso(record.firstProgressAtMs)}`,
    `p25=${iso(record.progress25AtMs)}`,
    `p50=${iso(record.progress50AtMs)}`,
    `p75=${iso(record.progress75AtMs)}`,
    `verifying=${iso(record.verificationAtMs)}`,
    `verificationSource=${record.verificationInferred ? 'completion-bound' : 'observed'}`,
    `ready=${iso(record.readyAtMs)}`,
    `pauses=${record.pauseCount}`,
    `state=${record.lastState}`,
  ].join('; ');
}

function metricLine(label: string, value: TransferBenchmarkMetric): string {
  return `${label}=n:${value.sampleCount}; p50:${duration(value.p50Ms)}; p95:${duration(value.p95Ms)}; budget:${duration(value.budgetMs)}; p50Result:${result(value.p50WithinBudget)}; p95Result:${result(value.p95WithinBudget)}`;
}

function metric(values: readonly number[], budgetMs: number): TransferBenchmarkMetric {
  const p50Ms = percentile(values, 0.5);
  const p95Ms = percentile(values, 0.95);
  return {
    sampleCount: values.length,
    p50Ms,
    p95Ms,
    budgetMs,
    p50WithinBudget: p50Ms === null ? null : p50Ms <= budgetMs,
    p95WithinBudget: p95Ms === null ? null : p95Ms <= budgetMs,
  };
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? null;
}

function upsertRecord(store: TransferBenchmarkStore, record: TransferBenchmarkRecord): void {
  const index = store.records.findIndex(
    (candidate) => candidate.photoTag === record.photoTag && candidate.kind === record.kind,
  );
  if (index === -1) store.records.push(record);
  else store.records[index] = record;
}

function parseStore(value: JsonValue | undefined): TransferBenchmarkStore {
  if (!isRecord(value) || value.schemaVersion !== STORE_VERSION || !Array.isArray(value.records)) {
    return { schemaVersion: STORE_VERSION, records: [] };
  }
  const records: unknown[] = value.records;
  return {
    schemaVersion: STORE_VERSION,
    records: records
      .map(parseBenchmarkRecord)
      .filter((record): record is TransferBenchmarkRecord => record !== null)
      .slice(0, MAX_RECORDS),
  };
}

function parseBenchmarkRecord(value: unknown): TransferBenchmarkRecord | null {
  if (!isRecord(value) || value.schemaVersion !== STORE_VERSION) return null;
  const nullableTimestamps = [
    value.sourcePublishedAtMs,
    value.startedAtMs,
    value.firstProgressAtMs,
    value.progress25AtMs,
    value.progress50AtMs,
    value.progress75AtMs,
    value.verificationAtMs,
    value.readyAtMs,
  ];
  const valid = (
    typeof value.tripTag === 'string' && TAG_PATTERN.test(value.tripTag) &&
    typeof value.photoTag === 'string' && TAG_PATTERN.test(value.photoTag) &&
    typeof value.resourceTag === 'string' && TAG_PATTERN.test(value.resourceTag) &&
    (value.kind === 'THUMBNAIL' || value.kind === 'ORIGINAL') &&
    isNonNegativeSafeInteger(value.byteLength) &&
    isWallClockTimestamp(value.queuedAtMs) &&
    isWallClockTimestamp(value.lastProgressAtMs) &&
    isNonNegativeSafeInteger(value.lastProgressBytes) &&
    isNonNegativeSafeInteger(value.pauseCount) &&
    (value.verificationInferred === undefined || typeof value.verificationInferred === 'boolean') &&
    nullableTimestamps.every((candidate) => candidate === null || isWallClockTimestamp(candidate)) &&
    isTransferState(value.lastState)
  );
  if (!valid) return null;
  return {
    schemaVersion: STORE_VERSION,
    tripTag: value.tripTag as string,
    photoTag: value.photoTag as string,
    resourceTag: value.resourceTag as string,
    kind: value.kind as ResourceKind,
    byteLength: value.byteLength as number,
    sourcePublishedAtMs: value.sourcePublishedAtMs as number | null,
    queuedAtMs: value.queuedAtMs as number,
    startedAtMs: value.startedAtMs as number | null,
    firstProgressAtMs: value.firstProgressAtMs as number | null,
    progress25AtMs: value.progress25AtMs as number | null,
    progress50AtMs: value.progress50AtMs as number | null,
    progress75AtMs: value.progress75AtMs as number | null,
    verificationAtMs: value.verificationAtMs as number | null,
    // v1 records written before provenance was added cannot prove that the
    // verification boundary was observed, so exclude them from normalization.
    verificationInferred: value.verificationInferred !== false,
    readyAtMs: value.readyAtMs as number | null,
    lastProgressAtMs: value.lastProgressAtMs as number,
    lastProgressBytes: value.lastProgressBytes as number,
    pauseCount: value.pauseCount as number,
    lastState: value.lastState as TransferRecord['state'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isWallClockTimestamp(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= MAX_DATE_MS;
}

function checkedTimestamp(value: number): number {
  if (!isWallClockTimestamp(value)) throw new Error('Benchmark clock returned an invalid timestamp.');
  return value;
}

function isTransferState(value: unknown): value is TransferRecord['state'] {
  return value === 'queued' || value === 'transferring' || value === 'verifying' ||
    value === 'paused' || value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isTerminalTransferState(value: TransferRecord['state']): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function benchmarkTimeline(
  record: TransferBenchmarkRecord,
  includeSourceClock: boolean,
): number[] {
  const values: (number | null)[] = [
    includeSourceClock ? record.sourcePublishedAtMs : null,
    record.queuedAtMs,
    record.startedAtMs,
    record.firstProgressAtMs,
    record.progress25AtMs,
    record.progress50AtMs,
    record.progress75AtMs,
    record.verificationAtMs,
    record.readyAtMs,
  ];
  return values.filter((value): value is number => value !== null);
}

function isNonDecreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value >= (values[index - 1] ?? value));
}

function isSafeDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function tag(value: string): string {
  return sha256Hex(textEncoder.encode(value)).slice(0, 12);
}

function exportTag(value: string): string {
  return TAG_PATTERN.test(value) ? value : tag(value);
}

function iso(value: number | null): string {
  return value === null ? '-' : isWallClockTimestamp(value)
    ? new Date(value).toISOString()
    : 'invalid';
}

function duration(value: number | null): string {
  return value === null ? 'n/a' : `${value}ms`;
}

function result(value: boolean | null): string {
  return value === null ? 'n/a' : value ? 'PASS' : 'MISS';
}
