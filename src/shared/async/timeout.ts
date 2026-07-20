// oz-erp-edge/src/shared/async/timeout.ts
export class OperationTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

export async function withTimeout<T>(input: {
  readonly timeoutMs: number;
  readonly timeoutMessage: string;
  readonly operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new OperationTimeoutError(input.timeoutMessage));
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([input.operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
