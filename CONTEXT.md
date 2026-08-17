# Context

## Current Task
Veröffentlichung: Checker-Blocker behoben, 0.3.29-Fixes auf main; npm-Publish braucht OTP.

## Key Decisions
- Node >=22, Tests 22/24; deploy-Job auf Node 24.
- News in io-package nur 0.3.29/0.3.28 (nur diese sind bzw. werden auf npm sein).
- Trusted Publishing und Forum-Thread bleiben manuell.

## Next Steps
- `npm publish` mit OTP, dann `npm owner add bluefox iobroker.irrigation`.
- Trusted Publishing auf npmjs.com setzen.
- Forum-Tester-Thread.
