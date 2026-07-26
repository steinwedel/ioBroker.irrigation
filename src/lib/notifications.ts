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
        const sends: Promise<void>[] = [];
        if (config.pushoverInstance) {
            sends.push(this.sendTo(config.pushoverInstance, { title, message }));
        }
        if (config.telegramInstance) {
            sends.push(this.sendTo(config.telegramInstance, `${title}: ${message}`));
        }
        if (sends.length === 0) {
            this.deps.adapter.log.debug(`Notification "${title}" not sent: no instance configured.`);
            return;
        }
        // Use allSettled (rather than Promise.all) so that a hanging/failing
        // channel never prevents the other channel's send from completing -
        // sendTo() already catches and logs its own errors, so there is
        // nothing left to inspect on the settled results here.
        await Promise.allSettled(sends);
    }

    private async sendTo(instance: string, message: unknown): Promise<void> {
        try {
            await this.deps.adapter.sendToAsync(instance, 'send', message);
        } catch (error) {
            this.deps.adapter.log.warn(`Failed to send notification via ${instance}: ${(error as Error).message}`);
        }
    }
}
