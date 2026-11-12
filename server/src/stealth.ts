/**
 * Page-level stealth patches.
 *
 * Patchright's own patches apply at launch; we connect over CDP to a stock
 * browser (the extension relay or `--remote-debugging-port`), so those never
 * run. This script is injected into every agent page instead: document start
 * for future navigations, and once into the current document on connect.
 *
 * It is a mitigation, not invisibility: `chrome.debugger` still shows the
 * browser's "started debugging" bar, and a page can always fingerprint an
 * unusual environment. Disable with AETHER_STEALTH=0.
 */
export const STEALTH_SCRIPT = `
(function() {
    const safely = (patch) => {
        try {
            patch();
        } catch (error) {
            console.debug('[Aether stealth] patch skipped', error);
        }
    };

    const makeNative = (fn, name) => {
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
        Object.defineProperty(fn, 'toString', {
            value: () => \`function \${name}() { [native code] }\`,
            configurable: true,
            writable: true
        });
    };

    const mockGetter = (obj, prop, value) => {
        if (!obj) return;
        const desc = Object.getOwnPropertyDescriptor(obj, prop) || { configurable: true, enumerable: true };
        if (desc.configurable === false) return;
        const getter = () => value;
        makeNative(getter, \`get \${prop}\`);
        Object.defineProperty(obj, prop, { ...desc, get: getter });
    };

    // 1. navigator.webdriver
    safely(() => mockGetter(navigator, 'webdriver', undefined));

    // 2. chrome.runtime without replacing existing Chrome globals
    safely(() => {
        const chromeObj = window.chrome || {};
        chromeObj.runtime = chromeObj.runtime || {};
        Object.assign(chromeObj.runtime, {
            OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available', THROTTLED: 'throttled' }
        });
        window.chrome = chromeObj;
    });

    // 3. languages
    safely(() => mockGetter(navigator, 'languages', ['en-US', 'en']));

    // 4. plugins
    safely(() => mockGetter(navigator, 'plugins', (() => {
        const plugins = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
        ];
        const p = [...plugins];
        p.item = (i) => plugins[i];
        p.namedItem = (n) => plugins.find(x => x.name === n);
        p.refresh = () => {};
        makeNative(p.item, 'item');
        makeNative(p.namedItem, 'namedItem');
        makeNative(p.refresh, 'refresh');
        return p;
    })()));

    // 5. WebGL fingerprint
    safely(() => {
        const contexts = [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean);
        for (const Context of contexts) {
            const getParameter = Context.prototype.getParameter;
            if (typeof getParameter !== 'function') continue;
            Context.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Intel Inc.';
                if (parameter === 37446) return 'Intel(R) Iris(TM) Graphics 6100';
                return getParameter.apply(this, arguments);
            };
            makeNative(Context.prototype.getParameter, 'getParameter');
        }
    });

    // 6. permissions.query
    safely(() => {
        const permissions = window.navigator.permissions;
        if (!permissions || typeof permissions.query !== 'function') return;
        const originalQuery = permissions.query.bind(permissions);
        permissions.query = (parameters) => (
            parameters && parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters)
        );
        makeNative(permissions.query, 'query');
    });

    // 7-8. deviceMemory / hardwareConcurrency
    safely(() => { if (!navigator.deviceMemory) mockGetter(navigator, 'deviceMemory', 8); });
    safely(() => { if (!navigator.hardwareConcurrency) mockGetter(navigator, 'hardwareConcurrency', 4); });

    // 9. headless window metrics
    safely(() => {
        if (window.outerHeight === 0) window.outerHeight = window.innerHeight;
        if (window.outerWidth === 0) window.outerWidth = window.innerWidth;
    });
})();
`;

/** Stealth injection is on unless AETHER_STEALTH=0/false. */
export function stealthEnabled(): boolean {
    const value = process.env.AETHER_STEALTH;
    return value !== "0" && value !== "false";
}
