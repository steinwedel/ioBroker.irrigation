# Context

## Current Task
Priorität 5 (Wetter/Verdunstung) teilweise umgesetzt: Windgrenze, Böengrenze und Hysterese ergänzt.

## Key Decisions
- Neues `WindMonitor`-Modul spiegelt SensorManager/DwdRestriction-Muster; `evaluateWindPause()` ist eine reine, getestete Entscheidungsfunktion.
- `AutomationEngine.setWindPause()` ist strukturell identisch zu `setRainPause()`, mit eigenem `pauseReason: 'wind'`.

## Next Steps
- Niederschlagsprognose, ET-/Verdunstungsfaktor und Durchflussminimum/-maximum aus Priorität 5 bleiben offen.
