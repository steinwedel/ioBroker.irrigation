// This file extends the AdapterConfig type from "@iobroker/types"
import type { IrrigationNativeConfig } from './types';

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        interface AdapterConfig extends IrrigationNativeConfig {}
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};