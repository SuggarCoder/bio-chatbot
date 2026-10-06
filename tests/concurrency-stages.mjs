// Synthetic correctness stages, NOT production throughput certification.
import { spawnSync } from 'node:child_process';
for (const concurrency of [16, 32, 64, 100]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/concurrency-pglite.mjs'], {
    env: { ...process.env, REVIEW_CONCURRENCY: String(concurrency) }, stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
