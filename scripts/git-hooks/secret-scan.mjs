/**
 * Pre-commit secret scan (SE-4). Runs gitleaks over the staged diff when the
 * binary is installed; warns and passes when it isn't — CI always enforces the
 * scan (see the `quality` job in .github/workflows/ci.yml), so a missing local
 * binary must not block commits.
 */

import { spawnSync } from 'node:child_process'

const probe = spawnSync('gitleaks', ['version'], { stdio: 'ignore', shell: true })
if (probe.status !== 0) {
  console.warn('[hooks] gitleaks not installed — secret scan skipped locally (CI still enforces it)')
  process.exit(0)
}

const scan = spawnSync(
  'gitleaks',
  ['protect', '--staged', '--redact', '--config', '.gitleaks.toml'],
  { stdio: 'inherit', shell: true },
)
process.exit(scan.status ?? 1)
