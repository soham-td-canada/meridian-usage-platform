// thread-stream (a Fastify -> pino type dependency) still references the
// `TransferListItem` type that @types/node 26 removed. Declare it so the library types resolve
// without relaxing any compiler option. Type-only, one alias, used solely by that .d.ts; delete it
// once thread-stream stops referencing the name (tsc then reports no error with this file removed).
import 'node:worker_threads';

declare module 'worker_threads' {
  type TransferListItem = ArrayBuffer | MessagePort;
}
