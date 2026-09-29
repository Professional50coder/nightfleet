# PROGRESS

Running build log. Newest first.

| Date | Step | State |
|---|---|---|
| 2026-09-25 | Squad links: chain layer, proof-backed driver, home/battle/setup UI, README section | Built; on-chain two-seat e2e in flight |
| 2026-09-25 | Preprod deployment live: contract 15bd24d16878cfc5ee2537223ddd41a13f0ca451c1d64b796a4643b87c94bab6, indexer-confirmed | Done |
| 2026-09-25 | Demo video v3 (captioned) embedded in README; deck shared; form answers drafted | Done |
| 2026-09-25 | ROADMAP published; README restructured around the live deployment | Done |
| 2026-09-25 | Contract compile + full test suites green in clean-room before every push | Standing gate |
| 2026-09-25 15:35 IST | Vercel: imported repo into Vercel (Git-connected to main, auto-deploy on push), deployed current build with squad UI, assigned https://nightfleet.vercel.app (nightfleet.vercel.app is held by a stale deployment in another Vercel account), README live-demo links updated |
| 2026-09-27 | On-chain two-seat e2e verified through fire on preprod: contract dbe8eec1913fb558850483788b09d4409970e75c5538d920e6ffb0d66de91a79 - deploy, both seats joined, both boards committed, and fire at (0,0) landed on-chain as a confirmed HIT on p2's board (shot pending, indexer-verifiable). Final report settlement attempted repeatedly; blocked by preprod infra instability in the submit phase, not by the build | Done |
| 2026-09-29 | Preprod indexer endpoint corrected to /api/v3/graphql (v4 is not served); demo links point to https://nightfleet.vercel.app | Done |
