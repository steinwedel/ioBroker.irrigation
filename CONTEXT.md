# Context

## Current Task
Admin-UI (Steuerung-Tab) auf Gruppenboxen für Saison/Regen/Wind/Frost/Temperatur umgestellt und live auf haus20a verifiziert.

## Key Decisions
- Gruppenboxen nutzen `type: panel` + `innerStyle` (nicht `style`, sonst doppelter Rahmen) für einzelnen, vollbreiten Rahmen.
- Checkbox jeweils als erstes Item im Panel platziert (Kopfzeile im Rahmen), abhängige Felder darunter.
- Wichtig: `npm install <tgz>` reicht für jsonConfig.json-Änderungen nicht aus; zusätzlich `iobroker upload irrigation` + `iobroker restart admin.0` nötig, sonst liefert Admin veraltete Konfiguration aus.

## Next Steps
- Keine offenen Schritte für diese Umsetzung.
