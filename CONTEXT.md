# Context

## Current Task
Direkte und geplante Ventilstarts verwenden dieselbe Bewässerungsdauer.

## Key Decisions
- `duration` in Minuten ersetzt den alten separaten `runFor`-Wert.
- Bestehende `runFor`-Konfigurationen werden beim Start migriert und entfernt.

## Next Steps
- Validierung ausführen.
