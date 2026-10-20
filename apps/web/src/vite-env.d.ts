/** Vite's `?worker` imports: the module's default export constructs the worker. */
declare module "*?worker" {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}
