![Logo](admin/irrigation.png)
# ioBroker.irrigation

[![NPM version](https://img.shields.io/npm/v/iobroker.irrigation.svg)](https://www.npmjs.com/package/iobroker.irrigation)
[![Downloads](https://img.shields.io/npm/dm/iobroker.irrigation.svg)](https://www.npmjs.com/package/iobroker.irrigation)
![Number of Installations](https://iobroker.live/badges/irrigation-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/irrigation-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.irrigation.png?downloads=true)](https://nodei.co/npm/iobroker.irrigation/)

**Tests:** ![Test and Release](https://github.com/steinwedel/ioBroker.irrigation/workflows/Test%20and%20Release/badge.svg)

## irrigation adapter for ioBroker

Controls irrigation zones, valves and watering schedules based on sensors and weather data.

### Features
- Valve support for Gardena (smartgarden), Homematic, Rain Bird and generic ioBroker states, with auto-discovery via object-tree scanning
- Zones with configurable duration, weekday schedule, groups and rain/soil-moisture based skipping
- Plans that group zones for combined watering runs, with automatic parallel batching based on pump capacity
- Manual per-zone watering, independent of the automatic schedule
- Configurable timer schedule and iCal calendar trigger
- Optional legal watering restriction based on DWD weather data (heat-related bans)
- Optional weather API integration (OpenWeatherMap)
- Water consumption tracking and flow-based leak/clog detection with calibration
- Notifications via Pushover/Telegram
- Normal and expert configuration modes in the admin UI

### Known limitations
- Gardena auto-discovery skips valves whose name is still the Gardena default placeholder (e.g. "Valve 1", "Valve 2", ...), since these usually correspond to unused/unconnected outputs on the controller. Rename the valve in the Gardena app to something else if it should be discovered.

---

## User Manual

### Quick Start — Minimal Setup

The fastest way to get your irrigation running with just two steps:

1. **Add your valves** — Open the **Valves** tab, click **Scan for valves** to auto-discover connected valves (Gardena, Homematic, Rainbird) or manually add a generic valve by entering its ioBroker state ID.
2. **Set a schedule** — Open the **Control** tab, enable **Automatic mode** and add one or more timer times (e.g. `06:00` and `19:00`).

Save the configuration. The adapter will now water all zones on all days at the configured times. Every valve gets a default zone with a duration of 10 minutes.

---

### Configuration Tabs

The adapter configuration is organized into tabs. In **Normal mode** you see 5 tabs; enable **Expert mode** on the first tab to unlock additional settings.

#### Tab: General

| Setting | Description |
|---------|-------------|
| Expert mode | Shows advanced configuration tabs (Sensors, Weather API, Legal Restriction, Notifications) and adds expert-only columns to the Zones and Control tabs. |

---

#### Tab: Valves

A valve is the physical output that opens or closes a water circuit. Each valve must be configured before you can assign zones to it.

**Auto-Discovery (recommended):**
1. Select your valve type (Gardena, Homematic, Rainbird, Generic, or All).
2. If prompted, select the corresponding ioBroker adapter instance.
3. Click **Scan for valves** — discovered valves are added to the table automatically.

**Manual Configuration:**
Add entries to the table directly:

| Column | Description |
|--------|-------------|
| Name | A descriptive name for the valve (e.g. "Front lawn", "Hedge"). |
| Type | Valve type: **Gardena** (smartgarden), **Homematic**, **Rainbird**, or **Generic** (any writable boolean state). |
| Manual run duration (s) | How long the valve runs when started manually (in seconds, default 600 = 10 min). |
| State id | The ioBroker state ID that controls the valve (on/off). For Gardena this is the `duration_value` state. |
| All-off state id | Expert only — a master stop state that shuts down all valves at once (Gardena: `stop_all_valves_i`, Rainbird: `stopIrrigation`). |

- **Delete all valves** removes all entries with a confirmation prompt.

---

#### Tab: Zones

A zone represents one irrigation area and is linked to exactly one valve. Zones are where you define watering durations, weekday restrictions, and sensor dependencies.

| Column | Description |
|--------|-------------|
| Name | Zone name (e.g. "Lawn front", "Vegetable beds"). |
| Valve index | The index of the valve this zone controls (1 = first valve in the Valves table). |
| Duration (min) | Watering duration for automatic schedule runs. |
| Enabled | Enable or disable this zone globally. |
| Rain independent | Expert — if enabled, the zone runs even when the rain sensor is active. |
| Moisture threshold (%) | Expert — skip watering if soil moisture is at or above this percentage (0 = disabled). |
| Manual duration (min) | Expert — duration used when starting this zone manually. |
| Flow sensor state id | Expert — ioBroker state ID of a flow sensor for consumption tracking and leak detection. |
| Flow rate (l/min) | Expert — estimated water flow rate (used for batching and consumption calculation). |
| Groups (comma separated) | Expert — tags to assign the zone to specific plans (e.g. `Lawn`, `Beds`). |
| Weekdays (0=Sun..6=Sat) | Expert — restrict watering to specific days (e.g. `1,3,5` = Mon, Wed, Fri). Empty = all days. |

---

#### Tab: Plans

Plans group zones by tags for combined watering runs. When a plan is triggered, it waters all zones whose **Groups** match the plan's groups.

| Column | Description |
|--------|-------------|
| Name | Plan name (e.g. "Lawn plan", "Evening run"). |
| Groups | Comma-separated group names. Only zones that have at least one matching group are included. Leave empty to include all zones. |

The built-in default plan **"Alle"** (all zones) has empty groups and therefore always waters every enabled zone.

**Example:** Zone "Rasen vorne" has groups `Lawn`, Zone "Hecke" has groups `Hedge`, Zone "Beet" has groups `Beds,Lawn`. A plan with groups `Lawn` would water "Rasen vorne" and "Beet" but not "Hecke".

---

#### Tab: Control

Central scheduling and behavior settings.

**Normal mode:**

| Setting | Description |
|---------|-------------|
| Automatic mode enabled | Master switch for all automatic watering. When disabled, only manual starts are possible. |
| Timer times | One or more times in `HH:MM` format. At each time, the first plan in the Plans table is triggered. |

**Expert mode:**

| Setting | Description |
|---------|-------------|
| Duration extension factor | Multiplier applied to all zone durations (0.5–5.0). Use 0.5 for half durations, 2.0 for double. |
| Pump capacity (l/min) | Maximum water output of your pump. When set > 0, zones are batched in parallel if their combined flow rate does not exceed this value. Set to 0 for purely sequential watering. |
| Pause between batches (min) | Waiting time between batch runs to allow water to soak in. |
| Season pause enabled | Pauses all automatic watering outside a defined season. |
| Season start / end month | The months (1–12) between which automatic watering is allowed. Supports wrap-around (e.g. Nov–Feb for winter pause). |
| Frost protection enabled | Blocks automatic watering when the temperature falls below the threshold. |
| Frost protection min. temperature (°C) | Temperature below which watering is skipped. Requires a temperature sensor to be configured. |
| iCal adapter instance | ioBroker iCal adapter instance for calendar-based scheduling. |
| iCal trigger state id | State that triggers a calendar lookup (set by iCal adapter when events start). |
| iCal event title prefix | Text that calendar events must start with to be recognized (default: "Bewässerung"). The part after the prefix (and optional colon/dash) is matched against plan names. |

**iCal Example:** A calendar event titled "Bewässerung: Rasen" triggers the plan named "Rasen". "Bewässerung - Beete" triggers the plan "Beete".

---

#### Tab: Sensors (Expert)

Connect external sensor states for weather-dependent watering decisions.

| Setting | Description |
|---------|-------------|
| Rain sensor state id | Boolean state (`true` = rain detected). When active, all zones are skipped except those marked **Rain independent**. |
| Soil moisture sensor state id | Number state (0–100%). Zones with a **Moisture threshold** above 0 are skipped if the sensor value exceeds their threshold. |
| Temperature sensor state id | Number state (°C). Used for frost protection (see Control tab). |

---

#### Tab: Weather API (Expert)

Integrates live weather data from OpenWeatherMap into ioBroker states.

| Setting | Description |
|---------|-------------|
| Weather API enabled | Enable/disable weather data polling. |
| API type | Currently only OpenWeatherMap is supported. |
| API key | Your OpenWeatherMap API key (stored encrypted). Free tier is sufficient for most use cases. |
| Latitude / Longitude | Geographic coordinates for the weather location. |
| Poll interval (min) | How often weather data is fetched (minimum 10 minutes recommended for free API tier). |

Weather data is published to these states: `weather.temperature`, `weather.precipitation`, `weather.precipitationChance`, `weather.lastUpdate`.

---

#### Tab: Legal Restriction (Expert)

In Germany, municipalities may impose watering bans during heat waves. This adapter can check DWD (German Weather Service) data and pause watering automatically.

| Setting | Description |
|---------|-------------|
| Legal restriction check enabled | Enable/disable DWD-based restriction checking. |
| DWD station id | DWD weather station ID (default: 10338 = Düsseldorf). Find your station at [opendata.dwd.de](https://opendata.dwd.de/weather/weather_reports/poi/). |
| Restriction start/end month | Months during which restrictions can apply. |
| Restriction start/end hour | Time window during which temperature is checked. |
| Minimum temperature (°C) | Temperature above which the restriction becomes active. |
| Check interval (min) | How often the DWD data is polled. |

When a restriction is active, running automation is paused and resumes automatically once the conditions clear.

---

#### Tab: Notifications (Expert)

Receive alerts about adapter events via Pushover or Telegram.

| Setting | Description |
|---------|-------------|
| Pushover instance | ioBroker Pushover adapter instance for push notifications. |
| Telegram instance | ioBroker Telegram adapter instance for message notifications. |
| Water consumption tracking enabled | Records water usage per zone and aggregates (today, week, month, total). |

Notifications are sent for events such as: watering started/completed, leak detected, clog suspected, legal restriction activated.

---

### Usage Scenarios

#### Manual Zone Watering

You can manually start a zone at any time, regardless of the automatic schedule or sensor states:

- Via ioBroker states: set `irrigation.0.zones.zone_N.manualStart` to `true`. The zone runs for the configured **Manual duration**.
- Automatic watering is paused during manual runs and resumes afterwards.

#### Manual Plan Watering

To run a complete plan manually, set `irrigation.0.control.manualStart` to `true`. This runs the first plan in the Plans table immediately, respecting all sensor checks and batching rules.

#### Flow Monitoring and Leak Detection

When flow sensors are configured per zone:

1. **Calibrate** each zone by triggering `calibrateFlow` — the valve opens for 120 seconds, measures actual flow, and stores the calibrated rate.
2. During watering, actual flow is compared to the calibrated value. Deviations over ±30% trigger alerts.
3. If the flow sensor detects water movement while all valves are closed, a leak alert is triggered.

---

### Step-by-Step: From Simple to Advanced

**Level 1 — Basic Timer Watering:**
1. Scan or add your valves (Valves tab).
2. Add zones with names and desired durations (Zones tab).
3. Enable automatic mode and set timer times (Control tab).
4. Save — your garden waters on schedule.

**Level 2 — Zone Groups and Plans:**
1. Assign group tags to zones, e.g. `Lawn`, `Beds`, `Pots` (Zones tab, expert columns).
2. Create plans that reference these groups (Plans tab).
3. Use iCal to trigger specific plans on specific days.

**Level 3 — Sensor-Based Control:**
1. Enable Expert mode.
2. Connect a rain sensor to skip watering on rainy days.
3. Connect a soil moisture sensor to skip zones that are already wet enough.
4. Enable frost protection to prevent watering in freezing conditions.

**Level 4 — Parallel Watering and Optimization:**
1. Enter your pump capacity (l/min) in the Control tab.
2. Set flow rates per zone — the adapter will automatically batch zones for parallel watering.
3. Add a pause between batches to let water soak in.

**Level 5 — Consumption Tracking and Monitoring:**
1. Connect flow sensors per zone.
2. Calibrate each zone's flow rate.
3. Enable water consumption tracking.
4. Set up notifications (Pushover/Telegram) to receive alerts.

**Level 6 — Legal Compliance and Weather:**
1. Enable the DWD legal restriction check with your local station ID.
2. Configure the OpenWeatherMap API for weather data in ioBroker.
3. Use weather states in your own automations (e.g. block watering if rain is forecast).


## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Gerhard Steinwedel) **NEW**: Smartgarden API rate limiter — enforces 9/10s + 699/7d + 1s min-interval to prevent 504 bursts (Gardena API)
* (Gerhard Steinwedel) **FIXED**: Gardena valves now count down every second (adapter-owned tick, synced with smartgarden's 60s push); auto-stop suppressed (device closes itself)

## License
MIT License

Copyright (c) 2026 Gerhard Steinwedel <dev@steinwedel.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.