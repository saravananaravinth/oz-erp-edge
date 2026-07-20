import type { EdgeLogger, SafeLogRecord } from './observability.types.js';

function write(method: 'log' | 'error', record: SafeLogRecord): void {
  const serialized = JSON.stringify(record);
  if (method === 'error') {
    // eslint-disable-next-line no-console -- Cloudflare Workers Logs sink.
    console.error(serialized);
  } else {
    // eslint-disable-next-line no-console -- Cloudflare Workers Logs sink.
    console.log(serialized);
  }
}

export const edgeLogger: EdgeLogger = Object.freeze({
  info: (record) => {
    write('log', record);
  },
  error: (record) => {
    write('error', record);
  },
});
