import { PlaywrightDriver } from "./playwright";
import type { Driver } from "./types";

let driver: Driver | null = null;

/** The process-wide browser driver. Playwright (Patchright) is the only path. */
export function getDriver(): Driver {
    if (!driver) driver = new PlaywrightDriver();
    return driver;
}

export * from "./types";
