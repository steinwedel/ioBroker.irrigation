# Context

## Current Task
Die Ventilreihenfolge eines Plans wird explizit in `automation.plansData` gespeichert.

## Key Decisions
- `valveOrder` speichert die vollständige Reihenfolge unabhängig von `valveIndexes`.
- Bestehende Plan-Daten werden beim Start mit `valveOrder: []` migriert.

## Next Steps
- Validierung ausführen.
