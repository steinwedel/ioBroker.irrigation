# Context

## Current Task
Adapter für öffentliche Veröffentlichung vorbereitet (standalone release-script, CI-Deploy, Icon 512px/31KB).

## Key Decisions
- `npm run release` ist nur noch `release-script`; Changelog/News-Übersetzung bleibt in `../scripts/`.
- CI-Deploy ohne Sentry; npm Trusted Publishing muss einmalig auf npmjs.com eingerichtet werden.
- Icon von 1024px/839KB auf 512px/31KB reduziert (Adapter Checker).

## Next Steps
- GitHub-Repo `steinwedel/ioBroker.irrigation` anlegen und `main` + Tags pushen.
- npm Trusted Publishing für das Repo setzen, danach Tag-Push publiziert.
- PR nach ioBroker.repositories + Forum-Tester-Thread.
