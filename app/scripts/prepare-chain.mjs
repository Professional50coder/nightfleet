// Stage the compiled NightFleet contract + ZK assets for the browser build.
//
// Two sources, tried in order:
//   1. the sibling contract/managed build (local dev: `npm run compile` in contract/)
//   2. the nightfleet-zk release asset on GitHub (CI / Vercel, where the
//      Compact toolchain is not installed)
//
// Outputs:
//   src/vendor/nightfleet-contract/index.js  - the compiled contract module
//   public/zk/keys/*.{prover,verifier}       - proving/verification keys
//   public/zk/zkir/*.bzkir                   - circuit IR for the prover
// FetchZkConfigProvider resolves exactly these paths under the app origin.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const managed = path.resolve(appRoot, '../contract/managed');
const vendorDir = path.join(appRoot, 'src/vendor/nightfleet-contract');
const zkDir = path.join(appRoot, 'public/zk');

const RELEASE_URL =
  'https://github.com/Professional50coder/nightfleet/releases/download/zk-assets/nightfleet-zk.tar.gz';

function stage(sourceDir) {
  rmSync(vendorDir, { recursive: true, force: true });
  rmSync(zkDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  mkdirSync(path.join(zkDir, 'keys'), { recursive: true });
  mkdirSync(path.join(zkDir, 'zkir'), { recursive: true });
  cpSync(path.join(sourceDir, 'contract'), vendorDir, { recursive: true });
  cpSync(path.join(sourceDir, 'keys'), path.join(zkDir, 'keys'), { recursive: true });
  cpSync(path.join(sourceDir, 'zkir'), path.join(zkDir, 'zkir'), { recursive: true });
  console.log(`chain assets staged from ${sourceDir}`);
}

if (existsSync(path.join(managed, 'contract', 'index.js'))) {
  stage(managed);
} else {
  console.log('no local contract/managed build - downloading the zk-assets release');
  const tarball = path.join(tmpdir(), 'nightfleet-zk.tar.gz');
  execFileSync('curl', ['-fsSL', '-o', tarball, RELEASE_URL], { stdio: 'inherit' });
  const unpack = path.join(tmpdir(), `nightfleet-zk-${process.pid}`);
  mkdirSync(unpack, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', unpack], { stdio: 'inherit' });
  const root = existsSync(path.join(unpack, 'managed')) ? path.join(unpack, 'managed') : unpack;
  stage(root);
}
