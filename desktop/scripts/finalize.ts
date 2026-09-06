import { execFileSync } from 'node:child_process';
execFileSync('node', ['scripts/finalize.mjs'], { stdio: 'inherit' });
