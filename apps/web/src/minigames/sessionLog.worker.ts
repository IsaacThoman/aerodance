import type { SessionLine } from '../../../../packages/pose/sessionLog.ts';

// Only serialization lives here. Disk writes stay ordered by SessionLogWriter on the host.
self.onmessage = ({ data }: MessageEvent<SessionLine[]>) => {
  try { self.postMessage({ text: data.map(line => JSON.stringify(line)).join('\n') + '\n' }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
