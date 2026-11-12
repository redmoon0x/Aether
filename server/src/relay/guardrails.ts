/**
 * CDP guardrails.
 *
 * The relay drives the user's real browser, so a raw protocol command must not
 * be able to close the browser, wipe shared state, or change site permissions.
 * These commands are refused at the relay boundary, for both browser-level and
 * page-level clients.
 */
const REFUSED = new Set([
    "Browser.close",
    "Browser.crash",
    "Browser.crashGpuProcess",
    "Browser.setPermission",
    "Browser.grantPermissions",
    "Browser.resetPermissions",
    "Network.clearBrowserCookies",
    "Network.clearBrowserCache",
    "Storage.clearDataForOrigin",
    "Storage.clearDataForStorageKey",
    "Storage.clearCookies",
    "Page.bringToFront",
    "Target.activateTarget",
    "Target.createBrowserContext",
    "Target.disposeBrowserContext",
]);

export function assertCdpAllowed(method: string): void {
    if (REFUSED.has(method)) {
        throw new Error(
            `Aether refused '${method}': it would change shared browser state. ` +
                `Ask the user to do it themselves.`
        );
    }
}

export function isCdpAllowed(method: string): boolean {
    return !REFUSED.has(method);
}
