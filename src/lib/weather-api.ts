import type { IrrigationNativeConfig } from './types';

export interface WeatherApiDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
}

/**
 * Optional OpenWeatherMap polling integration. See plan section
 * "Wetter-API (optional)".
 */
export class WeatherApi {
    private readonly deps: WeatherApiDeps;
    private pollTimer: ReturnType<ioBroker.Adapter['setInterval']> | undefined;

    public constructor(deps: WeatherApiDeps) {
        this.deps = deps;
    }

    public async init(): Promise<void> {
        const config = this.deps.getConfig();
        await this.deps.adapter.setStateAsync('weather.enabled', { val: config.weather.enabled, ack: true });
        if (!config.weather.enabled || !config.weather.apiKey) {
            return;
        }

        const intervalMs = Math.max(1, config.weather.pollInterval) * 60 * 1000;
        this.pollTimer = this.deps.adapter.setInterval(() => {
            this.poll().catch(error =>
                this.deps.adapter.log.error(`Weather API poll failed: ${(error as Error).message}`),
            );
        }, intervalMs);
        await this.poll();
    }

    public destroy(): void {
        if (this.pollTimer) {
            this.deps.adapter.clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    private async poll(): Promise<void> {
        const config = this.deps.getConfig().weather;
        try {
            const url = `https://api.openweathermap.org/data/2.5/weather?lat=${config.latitude}&lon=${config.longitude}&appid=${config.apiKey}&units=metric`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const data = (await response.json()) as {
                main?: { temp?: number };
                rain?: { '1h'?: number };
                clouds?: { all?: number };
            };

            // Unlike rain/clouds below (which OpenWeatherMap legitimately omits to mean
            // "0"), a missing/non-numeric temperature is a genuine API/schema anomaly:
            // defaulting it to 0 would look like a real 0°C reading rather than
            // "unknown", so skip the write and keep the last known value instead.
            if (typeof data.main?.temp === 'number' && Number.isFinite(data.main.temp)) {
                await this.deps.adapter.setStateAsync('weather.temperature', { val: data.main.temp, ack: true });
            } else {
                this.deps.adapter.log.warn('Weather API response is missing a valid temperature value.');
            }
            await this.deps.adapter.setStateAsync('weather.precipitation', { val: data.rain?.['1h'] ?? 0, ack: true });
            // OpenWeatherMap's free "current weather" endpoint has no direct rain
            // probability field; cloud coverage is used as a rough proxy.
            await this.deps.adapter.setStateAsync('weather.precipitationChance', {
                val: data.clouds?.all ?? 0,
                ack: true,
            });
            await this.deps.adapter.setStateAsync('weather.lastUpdate', { val: Date.now(), ack: true });
            await this.deps.adapter.setStateAsync('info.connection', { val: true, ack: true });
        } catch (error) {
            this.deps.adapter.log.warn(`Weather API request failed: ${(error as Error).message}`);
            await this.deps.adapter.setStateAsync('info.connection', { val: false, ack: true });
        }
    }
}
