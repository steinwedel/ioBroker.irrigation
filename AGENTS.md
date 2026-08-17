# AGENTS.md — ioBroker Irrigation Adapter

## Projektkontext

Du arbeitest an einem **ioBroker Bewässerungsadapter** (`ioBroker.irrigation`).  
Der Adapter steuert Ventile direkt und führt Bewässerungsprogramme auf Basis von Zeitplänen, Sensordaten und optional Wetterinformationen aus.

**Kernfunktionen:**
- Direkte Ventilsteuerung mit eigenen Laufzeiten, Pausen, Flussraten
- Zeitgesteuerte und/oder sensorgesteuerte Bewässerungsprogramme
- Integration von Regensensoren, Bodenfeuchtesensoren
- Ventilsteuerung über ioBroker-States (Gardena, Homematic, Rainbird, Generic)
- Wasserverbrauchs-Tracking
- Optionale Wetter-API-Integration (Regenwahrscheinlichkeit, Temperatur)
- Manuelle Überbrückung und Saison-Pausen

### Build und Deploy

Lokales Deploy nutzt die Sammlungsscripts eine Ebene höher (`../scripts/`, `../.env`). Siehe `../AGENTS.md`. Keine adapter-lokalen `scripts/` anlegen.

Öffentliches Release im GitHub-Repo: `npm run release patch` (`release-script`, standalone).

```bash
../scripts/deploy.sh
../scripts/build.sh patch
```

---

## 1. ioBroker-Adapter-Grundregeln

Diese Regeln stammen aus dem [ioBroker AI Developer Guide](https://github.com/Jey-Cee/iobroker-ai-developer-guide) und sind **bindend**:

### Projektstruktur

- **NIE** ein Adapter-Projekt von Grund auf generieren oder von einem anderen Adapter kopieren
- **IMMER** den offiziellen Adapter Creator verwenden: `npx @iobroker/create-adapter@latest`
- GitHub-Repo-Name: `ioBroker.irrigation` (großes B)
- npm-Paketname: `iobroker.irrigation` (lowercase)

### Objekt-Hierarchie (CRITICAL)

```text
irrigation.0
├── valves
│   ├── valve_000
│   │   ├── state            (boolean, ack=true/read+write)
│   │   ├── enabled          (boolean, ack=true)
│   │   ├── duration         (number, ack=true)
│   │   ├── remainingDuration (number, ack=true)
│   │   ├── flowRateLpm      (number, ack=true)
│   │   ├── manualStart      (boolean, ack=false button)
│   │   ├── calibrateFlow    (boolean, ack=false button)
│   │   ├── waterCurrent     (number, ack=true)
│   │   └── waterTotal       (number, ack=true)
│   └── valve_NNN ...
├── programs
│   ├── program1
│   │   ├── active          (boolean, ack=true)
│   │   ├── running         (boolean, ack=true)
│   │   ├── nextRun         (string, ack=true)
│   │   ├── valves          (string/JSON, ack=true)
│   │   ├── startTime       (string, ack=true)
│   │   └── weekdays        (array, ack=true)
│   └── programN ...
├── sensors
│   ├── rainSensor          (boolean, ack=true)
│   ├── soilMoisture        (number, ack=true)
│   └── temperature         (number, ack=true)
└── info
    └── connection           (boolean, ack=true)
```

**Regeln:**
- Jedes Zwischenobjekt (`valves`, `valve_000`, `programs`, etc.) explizit mit `setObjectNotExists` anlegen
- Objekt-IDs nur `A-Za-z0-9-_` — keine Sonderzeichen, Leerzeichen oder Umlaute
- `device` → `channel` → `state` Hierarchie einhalten
- `ack=true` für finale Werte (Sensorwerte, Status), `ack=false` für Kommandos

### State Roles

- **NIE** `role: "state"` als Fallback verwenden
- Korrekte Rollen aus [STATE_ROLES.md](https://github.com/ioBroker/ioBroker/blob/master/doc/STATE_ROLES.md):

| Irrigation Use | Role | Type | Write |
|---|---|---|---|
| Ventil EIN/AUS | `switch` oder `switch.power` | boolean | true |
| Ventil-Öffnungswert | `level.valve` | number | true |
| Zone läuft gerade | `indicator.working` | boolean | false |
| Zone erreichbar | `indicator.reachable` | boolean | false |
| Regen erkannt | `sensor.rain` | boolean | false |
| Bodenfeuchte | `value.humidity` | number | false |
| Temperatur | `value.temperature` | number | false |
| Niederschlagsmenge | `value.precipitation` | number | false |
| Regenwahrscheinlichkeit | `value.precipitation.chance` | number | false |
| Regen heute | `value.rain.today` | number | false |
| Laufzeit/Dauer (r/o) | `value.timer` | number | false |
| Laufzeit setzen | `level.timer` | number | true |
| Intervall | `value.interval` | number | false |
| Wasserverbrauch | `value.fill` | number | false |
| Verbindungsstatus | `indicator.connected` | boolean | false |
| Gerätestatus | `info.status` | string/number | false |
| Manuelle Pause | `switch.mode.manual` | boolean | true |
| JSON-Daten | `json` | string | true |

**Generische Rollen (wenn keine spezifischere passt):**
- `state` — nur als letzter Ausweg, wenn keine andere Rolle zutrifft
- `text` — für String-Werte ohne spezifischere Rolle
- `list` — für Array-Werte (`common.type: "array"`)

### State common.type (Object Schema)

Mögliche `common.type` Werte für States: `number`, `boolean`, `string`, `array`, `object`, `json`, `mixed`, `multistate`, `file`.

**CRITICAL:** States mit `type: "array"`, `"object"`, `"mixed"` oder `"file"` MÜSSEN via `JSON.stringify()` serialisiert werden. `number` und `boolean` werden NICHT serialisiert.

```typescript
// RICHTIG: zone Zones als JSON-Array speichern
await this.createStateAsync('program1', '', 'zones', {
    type: 'string',        // JSON als String
    role: 'json',
    read: true,
    write: true
});
this.setState('program1.zones', JSON.stringify(['zone1', 'zone2']), true);

// RICHTIG: Enum-artige Werte über common.states
await this.createStateAsync('zone1', '', 'status', {
    type: 'number',
    role: 'indicator',
    states: { 0: 'OFF', 1: 'RUNNING', 2: 'PAUSED', 3: 'ERROR' },
    read: true,
    write: false
});
```

### Channel Roles (Object Schema)

Rollen für Channel-Objekte (`common.role`), sofern Channels verwendet werden:

| Channel Role | Verwendung für Irrigation |
|---|---|
| `switch` | Ventil-Kanal (EIN/AUS) |
| `sensor` | Regen-, Bodenfeuchte-, Temperatursensor |
| `thermo` | Temperatur-Überwachung |

Jeder Channel kann optionale States haben: `WORKING`, `MAINTENANCE`, `UNREACH` (z.B. `zone1.WORKING`, `zone1.UNREACH`).

### Timer und Ressourcen

```typescript
// RICHTIG — Adapter-eigene Timer
this.checkTimer = this.setTimeout(() => { ... }, 60000);
this.scheduleTimer = this.setInterval(() => { ... }, 1000);

// FALSCH — Node.js-Timer
setTimeout(() => { ... }, 60000);
setInterval(() => { ... }, 1000);
```

- `onUnload` MUSS **alle** Timer, Intervalle und Verbindungen aufräumen
- `adapter.terminate()` statt `process.exit()`
- **Compact Mode** prüfen: Start → Lauf → Stop → Neustart muss sauber funktionieren

### io-package.json Pflichtfelder

Diese Felder MÜSSEN in `io-package.json` korrekt gesetzt sein (KI macht hier häufig Fehler):

| Feld | Wert für irrigation |
|---|---|
| `dataSource` | `"poll"` (Adapter fragt Sensoren/APIs aktiv ab) |
| `mode` | `"daemon"` (Adapter läuft dauerhaft) |
| `adminUI.config` | `"json"` (JSONConfig, nicht `"html"`!) |
| `type` | `"climate-control"` oder `"garden"` |
| `connectionType` | `"local"` (oder `"cloud"` bei Wetter-API) |
| `supportedMessages` | `{ "custom": true }` |
| `titleLang` | `{ "en": "Irrigation", "de": "Bewässerung" }` |
| `desc` | Multilinguale Beschreibung |
| `platform` | `"Javascript/Node.js"` |
| `loglevel` | `"info"` (Default) |

### Commands vs. Statuses (ack-Flag)

```typescript
// COMMAND: ack=false — Benutzer/System will Aktion auslösen
// → Adapter führt Aktion aus und setzt danach ack=true
adapter.setState('zone1.active', true, false);  // Kommando: Zone einschalten

// STATUS: ack=true — Bestätigung vom Gerät/System
// → Adapter meldet aktuellen Zustand zurück
adapter.setState('zone1.active', true, true);   // Status: Zone ist aktiv
```

**Regel:** Auf `stateChange`-Events prüfen: wenn `state.ack === false` → Kommando ausführen; wenn `state.ack === true` → nur Status aktualisieren, nicht erneut ausführen (Endlosschleife vermeiden).

### State-Struktur

```typescript
{
    val: 1,                    // Wert (boolean, number, string)
    ack: true,                 // false=Kommando, true=Status
    ts: 1689000000000,         // Timestamp (ms), automatisch gesetzt
    lc: 1689000000000,         // Last change (ms), nur bei Wertänderung
    from: "system.adapter.irrigation.0",  // Quelle, automatisch
    expire: 60,                // optional: State verfällt nach X Sekunden → null
    q: 0x00                    // optional: Quality-Code (0x00 = good)
}
```

### Objekt-Hilfsfunktionen

```typescript
// Device → Channel → State anlegen (mit setObjectNotExists gegen Überschreiben)
await this.setObjectNotExistsAsync('zone1', {
    type: 'device',
    common: { name: 'Zone 1' },
    native: {}
});
await this.setObjectNotExistsAsync('zone1.active', {
    type: 'state',
    common: {
        name: 'Zone 1 active',
        type: 'boolean',
        role: 'switch',
        read: true,
        write: true
    },
    native: {}
});

// ODER über Helper-Funktionen:
await this.createDeviceAsync('zone1');
await this.createChannelAsync('zone1', 'status');
await this.createStateAsync('zone1', 'status', 'active', {
    type: 'boolean',
    role: 'switch',
    read: true,
    write: true
});
```

### Adapter-Events

```typescript
// Wichtigste Events in richtiger Reihenfolge:
adapter.on('ready', () => {
    // ALLE Initialisierungen HIER — NICHT im Konstruktor
    // Vor "ready" gibt es keine Konfiguration!
});

adapter.on('stateChange', (id, state) => {
    if (!state || state.ack) return; // Nur Kommandos verarbeiten
    // id = "irrigation.0.zone1.active"
});

adapter.on('unload', (callback) => {
    // ALLE Timer, Intervalle, Verbindungen aufräumen
    callback();
});
```

### Running Modes

| Mode | Verhalten |
|---|---|
| `daemon` | Dauerprozess (wird bei Crash neu gestartet) — **Standard für irrigation** |
| `schedule` | Startet nach Cron-Schedule (z.B. `0 6 * * *` — täglich um 6 Uhr) |
| `subscribe` | Startet, wenn `system.adapter...alive` true wird |
| `once` | Startet bei Config-Änderung, läuft einmal durch |
| `none` | Wird nicht gestartet |

---

## 2. Code-Standards

### Sprache
- **README.md, Logs, Code-Kommentare: Englisch**
- Admin-UI Labels: minimum Englisch + Deutsch (i18n-Struktur)

### ESLint
- `@iobroker/eslint-config` verwenden
- `npm run lint` muss mit `--max-warnings 0` durchlaufen
- 4 Spaces Einrückung (ioBroker-Standard)

### Abhängigkeiten
- `fetch` (Node.js native) statt `axios`
- `@iobroker/adapter-core` für Adapter-Basis
- Adapter-eigene Timer (`adapter.setTimeout`/`setInterval`)
- Kein `node-schedule` oder externe Scheduler für einfache Intervalle

### Logging
```typescript
this.log.debug(`Zone ${zoneId} status changed to ${status}`);
this.log.warn(`Rain sensor triggered — pausing all zones`);
this.log.error(`Valve control failed for zone ${zoneId}: ${error.message}`);
```

### Error Handling bei Geräte-/API-Zugriff
```typescript
try {
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
} catch (error) {
  this.log.error(`Weather API request failed: ${error.message}`);
  this.setState('info.connection', false, true);
}
```

---

## 3. Testing

### Framework
- **AUSSCHLIESSLICH** `@iobroker/testing` für Integrationstests
- Jest für Unit-Tests
- Test-Struktur wird vom Adapter Creator generiert

### Integrationstests
```javascript
const { tests } = require('@iobroker/testing');
tests.integration(path.join(__dirname, '..'), {
  defineAdditionalTests({ suite }) {
    suite('Irrigation adapter', (getHarness) => {
      // Config via harness.objects.setObject()
      // Start via harness.startAdapterAndWait()
      // Verify via harness.states.getState()
    });
  }
});
```

### CI/CD Pipeline (Reihenfolge zwingend)
1. `check-and-lint` (ESLint + Package Check) — läuft IMMER zuerst
2. `adapter-tests` (braucht `check-and-lint`)
3. `integration-tests` (braucht beide)

---

## 4. Admin UI (JSONConfig)

```json5
// admin/jsonConfig.json5
{
  type: "panel",
  items: {
    zones: {
      type: "table",
      label: "Irrigation Zones",
      items: {
        name: { type: "text", label: "Zone Name" },
        valveId: { type: "text", label: "Valve State ID" },
        duration: { type: "number", label: "Duration (min)", min: 1, max: 240 },
      }
    },
    rainSensor: {
      type: "text",
      label: "Rain Sensor State ID",
      help: "ioBroker state ID for rain detection"
    }
  }
}
```

### i18n / Übersetzungen
- **KEINE** direkten Sprachstrings in `jsonConfig.json5`
- Alle Labels über `admin/i18n/{lang}/translations.json`
- `npm run translate` nach Änderungen an Labels ausführen
- Validierung: `scripts/validate-translations.js`

---

## 5. Release & Changelog

### CHANGELOG.md
- Wird **automatisch** vom `@alcalzone/release-script` verwaltet — Einträge **NUR** unter `## **WORK IN PROGRESS**` schreiben
- Format: `* (author) **TYPE**: Description`
- Types: `NEW`, `FIXED`, `ENHANCED`
- Beim Release verschiebt das Script die WiP-Einträge in eine neue `### X.Y.Z (Datum)`-Sektion und leert den WiP-Bereich
- Die `README.md` verlinkt nur auf `CHANGELOG.md`

### Release-Prozess
- `npm run release patch` — Bugfixes (0.1.2 → 0.1.3)
- `npm run release minor` — neue Features (0.1.x → 0.2.0)
- `npm run release major` — breaking changes (0.x → 1.0.0)
- Release-Script: [AlCalzone release-script](https://github.com/AlCalzone/release-script) (bereits in `.releaseconfig.json` konfiguriert)
- Adapter Checker: https://www.iobroker.dev/adapter-check
- Vor Stable: Forum-Thread im [Tester-Bereich](https://forum.iobroker.net/category/91/tester)

---

## 6. Checkliste vor PR/Release

- [ ] `npm run lint` ohne Fehler/Warnings
- [ ] `npm test` bestanden
- [ ] `info.connection` State implementiert
- [ ] `onUnload` räumt alle Timer/Intervalle/Connections auf
- [ ] Compact Mode getestet
- [ ] Kein `process.exit()` im Code
- [ ] `encryptedNative`/`protectedNative` für Secrets gesetzt
- [ ] State Roles korrekt (nicht `role: "state"`)
- [ ] Objekt-Hierarchie `device → channel → state`
- [ ] README.md auf Englisch mit WORK IN PROGRESS Eintrag
- [ ] Übersetzungen synchron (`npm run translate`)
- [ ] Adapter Checker bestanden

---

## 7. Session Management

Nach jeder Session `CONTEXT.md` im Projekt-Root aktualisieren:
- **Current Task**: Ein Satz, woran gearbeitet wurde
- **Key Decisions**: Max. 3 Bullet Points
- **Next Steps**: Max. 3 Bullet Points

`CONTEXT.md` unter 20 Zeilen halten.

---

## 8. Hilfreiche Referenzen

| Ressource | URL |
|---|---|
| Adapter Creator | `npx @iobroker/create-adapter@latest` |
| Adapter Checker | https://www.iobroker.dev/adapter-check |
| Adapter-Referenz | https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/adapterref.md |
| Object Schema | https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/objectsschema.md |
| State Roles | https://github.com/ioBroker/ioBroker/blob/master/doc/STATE_ROLES.md |
| ioBroker Testing | https://github.com/ioBroker/testing |
| Translator | https://translator.iobroker.in/ |
| Adapter Requests | https://github.com/ioBroker/AdapterRequests/issues |
| Forum (Tester) | https://forum.iobroker.net/category/91/tester |