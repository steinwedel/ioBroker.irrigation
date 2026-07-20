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
var notifications_exports = {};
__export(notifications_exports, {
  NotificationManager: () => NotificationManager
});
module.exports = __toCommonJS(notifications_exports);
class NotificationManager {
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  async send(title, message) {
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
  async sendTo(instance, message) {
    try {
      await this.deps.adapter.sendToAsync(instance, "send", message);
    } catch (error) {
      this.deps.adapter.log.warn(`Failed to send notification via ${instance}: ${error.message}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NotificationManager
});
//# sourceMappingURL=notifications.js.map
