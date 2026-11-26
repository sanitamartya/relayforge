const DEFAULT_WORKER_CONCURRENCY = 10;
const MAX_WORKER_CONCURRENCY = 100;

export function parseWorkerConcurrency(value) {
  if (value === undefined || value === "") {
    return DEFAULT_WORKER_CONCURRENCY;
  }

  const concurrency = Number(value);

  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_WORKER_CONCURRENCY
  ) {
    throw new Error(
      `WEBHOOK_WORKER_CONCURRENCY must be an integer between 1 and ${MAX_WORKER_CONCURRENCY}`,
    );
  }

  return concurrency;
}
