"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var weather_api_exports = {};
__export(weather_api_exports, {
  WeatherApi: () => WeatherApi
});
module.exports = __toCommonJS(weather_api_exports);
class WeatherApi {
  deps;
  pollTimer;
  constructor(deps) {
    this.deps = deps;
  }
  async init() {
    const config = this.deps.getConfig();
    await this.deps.adapter.setStateAsync("weather.enabled", { val: config.weather.enabled, ack: true });
    if (!config.weather.enabled || !config.weather.apiKey) {
      return;
    }
    const intervalMs = Math.max(1, config.weather.pollInterval) * 60 * 1e3;
    this.pollTimer = this.deps.adapter.setInterval(() => {
      this.poll().catch(
        (error) => this.deps.adapter.log.error(`Weather API poll failed: ${error.message}`)
      );
    }, intervalMs);
    await this.poll();
  }
  destroy() {
    if (this.pollTimer) {
      this.deps.adapter.clearInterval(this.pollTimer);
      this.pollTimer = void 0;
    }
  }
  async poll() {
    var _a, _b, _c, _d, _e;
    const config = this.deps.getConfig().weather;
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${config.latitude}&lon=${config.longitude}&appid=${config.apiKey}&units=metric`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      if (typeof ((_a = data.main) == null ? void 0 : _a.temp) === "number" && Number.isFinite(data.main.temp)) {
        await this.deps.adapter.setStateAsync("weather.temperature", { val: data.main.temp, ack: true });
      } else {
        this.deps.adapter.log.warn("Weather API response is missing a valid temperature value.");
      }
      await this.deps.adapter.setStateAsync("weather.precipitation", { val: (_c = (_b = data.rain) == null ? void 0 : _b["1h"]) != null ? _c : 0, ack: true });
      await this.deps.adapter.setStateAsync("weather.precipitationChance", {
        val: (_e = (_d = data.clouds) == null ? void 0 : _d.all) != null ? _e : 0,
        ack: true
      });
      await this.deps.adapter.setStateAsync("weather.lastUpdate", { val: Date.now(), ack: true });
      await this.deps.adapter.setStateAsync("info.connection", { val: true, ack: true });
    } catch (error) {
      this.deps.adapter.log.warn(`Weather API request failed: ${error.message}`);
      await this.deps.adapter.setStateAsync("info.connection", { val: false, ack: true });
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WeatherApi
});
//# sourceMappingURL=weather-api.js.map
