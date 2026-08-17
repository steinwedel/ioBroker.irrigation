# Context

## Current Task
Adapter für öffentliche Veröffentlichung vorbereitet; Repo liegt unter https://github.com/steinwedel/ioBroker.irrigation.

## Key Decisions
- `npm run release` ist nur noch `release-script`; Changelog/News-Übersetzung bleibt in `../scripts/`.
- CI-Deploy ohne Sentry aktiviert; Icon auf 512px/31KB reduziert.
- origin zeigt auf GitHub; alter `/tmp`-Remote heißt `local-mirror`.

## Next Steps
- npm Trusted Publishing für das Repo setzen, dann Version auf npm publizieren.
- Adapter Checker + PR nach ioBroker.repositories.
- Forum-Tester-Thread.
