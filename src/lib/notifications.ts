import type { IrrigationNativeConfig } from './types';

export interface NotificationsDeps {
    adapter: ioBroker.Adapter;
    getConfig: () => IrrigationNativeConfig;
}

/**
 * Sends notifications via sendTo to configured Pushover/Telegram instances.
 * See plan section "Benachrichtigungen".
 */
export class NotificationManager {
    private readonly deps: NotificationsDeps;

    public constructor(deps: NotificationsDeps) {
        this.deps = deps;
    }

    public async send(title: string, message: string): Promise<void> {
        const config = this.deps.getConfig().notifications;
        if (config.pushoverInstance) {
            await this.sendTo(config.pushoverInstance, { title, message });
        }
        if (config.telegramInstance) {
            await this.sendTo(config.telegramInstance, `${title}: ${message}`);
        }
        if (!config.pushoverInstance && !config.telegramInstance) {
            this.deps.adapter.log.debug(`Notification "${title}" not sent: no instance configured.`);
        }
    }

    private async sendTo(instance: string, message: unknown): Promise<void> {
        try {
            await this.deps.adapter.sendToAsync(instance, 'send', message);
        } catch (error) {
            this.deps.adapter.log.warn(`Failed to send notification via ${instance}: ${(error as Error).message}`);
        }
    }
}
