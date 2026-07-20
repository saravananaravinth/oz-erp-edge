export type SafeLogValue = string | number | boolean | null | readonly string[];
export type SafeLogRecord = Readonly<Record<string, SafeLogValue>>;

export type EdgeLogger = Readonly<{
  info: (record: SafeLogRecord) => void;
  error: (record: SafeLogRecord) => void;
}>;
