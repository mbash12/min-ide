import http from "node:http";
import { app, session, type BrowserWindow, type Rectangle } from "electron";

import { FIGMA_SESSION_COOKIE_NAME, HOMEPAGE } from "Const";
import { logger } from "./Logger";
import type WindowManager from "./Ui/WindowManager";

export const DEFAULT_ENGINE_CONTROL_PORT = 44179;
export const ENGINE_PLUGIN_NAME = "Min Figma Bridge";

export function isMinFigmaEngine(): boolean {
  return process.env.MIN_FIGMA_ENGINE === "1";
}

export function engineControlPort(): number {
  const raw = Number(process.env.MIN_FIGMA_CONTROL_PORT || DEFAULT_ENGINE_CONTROL_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ENGINE_CONTROL_PORT;
}

export function enginePluginPath(): string | null {
  const value = process.env.MIN_FIGMA_PLUGIN?.trim();
  return value ? value : null;
}

export function parseFigmaFileKey(rawUrl: string): string | null {
  const match = String(rawUrl || "").match(
    /figma\.com\/(?:design|file|proto|board|deck)\/([A-Za-z0-9]+)/i,
  );
  return match ? match[1] : null;
}

let windowVisible = false;
let windowPriming = false;
let windowPrimeState: {
  win: BrowserWindow;
  bounds: Rectangle;
  opacity: number;
} | null = null;
let windowPrimeCssKey: string | null = null;
let savedBounds: Rectangle | null = null;
let engineProcessQuitting = false;

export function isEngineWindowVisible(): boolean {
  return windowVisible;
}

export function setEngineWindowVisible(visible: boolean): void {
  windowVisible = visible;
}

export function isEngineProcessQuitting(): boolean {
  return engineProcessQuitting;
}

export function markEngineProcessQuitting(): void {
  engineProcessQuitting = true;
}

export function watchMinParentProcess(): void {
  const parentPid = Number(process.env.MIN_FIGMA_PARENT_PID || 0);
  if (!parentPid || !Number.isFinite(parentPid)) return;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(timer);
      logger.warn("[engine] Min parent exited; quitting");
      markEngineProcessQuitting();
      app.exit(0);
    }
  }, 750);
}

/** Keep the user-visible visibility flag in sync with show/hide events.
 *  Transparent off-screen priming is intentionally excluded. */
export function trackEngineWindowVisibility(win: BrowserWindow): void {
  win.on("show", () => {
    if (!windowPriming) setEngineWindowVisible(true);
  });
  win.on("hide", () => setEngineWindowVisible(false));
  win.on("closed", () => setEngineWindowVisible(false));
}

function rememberBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const bounds = win.getNormalBounds();
  if (bounds.width > 50 && bounds.height > 50) savedBounds = bounds;
}

/** Really hide the engine window. Renderers keep running because every
 *  webPreferences sets backgroundThrottling:false and Chromium is launched
 *  with disable-backgrounding-occluded-windows, so plugins stay alive. */
export function hideEngineBrowserWindow(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  if (windowPrimeState?.win === win) {
    finishEngineWindowPrime(win);
    return;
  }
  rememberBounds(win);
  win.setSkipTaskbar(true);
  if (win.isVisible()) win.hide();
}

async function startEngineWindowPrime(win: BrowserWindow): Promise<void> {
  if (windowPrimeState?.win === win) return;
  const bounds = win.getBounds();
  windowPriming = true;
  windowPrimeState = {
    win,
    bounds,
    opacity: win.getOpacity(),
  };
  await clearEnginePrimeShield(win);
  try {
    windowPrimeCssKey = await win.webContents.insertCSS(
      "html, body { opacity: 0 !important; background: transparent !important; }",
    );
  } catch {
    /* Native opacity/off-screen positioning remain as fallback. */
  }
  // Figma only enables its editor/plugin runtime after the BrowserWindow is
  // mapped. Keep that activation completely outside the user's viewport.
  win.setSkipTaskbar(true);
  win.setIgnoreMouseEvents(true);
  win.setOpacity(0);
  win.setBounds({ ...bounds, x: -10000, y: -10000 });
  win.showInactive();
}

async function clearEnginePrimeShield(win: BrowserWindow): Promise<void> {
  const cssKey = windowPrimeCssKey;
  windowPrimeCssKey = null;
  if (!cssKey || win.isDestroyed()) return;
  try {
    await win.webContents.removeInsertedCSS(cssKey);
  } catch {
    /* The document may have navigated and removed the stylesheet already. */
  }
}

function finishEngineWindowPrime(win: BrowserWindow): void {
  const state = windowPrimeState;
  if (!state || state.win !== win) {
    windowPriming = false;
    return;
  }
  if (!win.isDestroyed()) {
    if (win.isVisible()) win.hide();
    win.setIgnoreMouseEvents(false);
    win.setOpacity(state.opacity);
    win.setBounds(state.bounds);
  }
  windowPrimeState = null;
  windowPriming = false;
  setEngineWindowVisible(false);
}

/** Readiness probe for Min: the window is created with show:false and only
 *  mapped by an explicit show RPC or the transparent plugin prime. */
export function ensureEngineRuntime(windowManager: WindowManager): void {
  const window = windowManager.getLastFocusedWindow();
  if (!window || window.win.isDestroyed()) return;
}

export function revealEngineWindow(windowManager: WindowManager, revealContent = true): void {
  void applyWindowVisibility(windowManager, true, revealContent);
}

async function applyWindowVisibility(
  windowManager: WindowManager,
  visible: boolean,
  revealContent = true,
): Promise<void> {
  const window = windowManager.getLastFocusedWindow();
  if (!window) return;
  const win = window.win;
  if (win.isDestroyed()) return;
  if (visible) {
    if (windowPrimeState?.win === win) finishEngineWindowPrime(win);
    await clearEnginePrimeShield(win);
    setEngineWindowVisible(true);
    win.setSkipTaskbar(false);
    if (savedBounds) {
      const bounds = savedBounds;
      savedBounds = null;
      win.setBounds(bounds);
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (revealContent) window.revealEngineContent();
  } else {
    hideEngineBrowserWindow(win);
  }
}

type CookieInput = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: Electron.CookiesSetDetails["sameSite"];
  url?: string;
};

type EngineControlDeps = {
  windowManager: WindowManager;
};

function json(res: http.ServerResponse, code: number, body: Record<string, unknown>): void {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://127.0.0.1",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cookieSetUrl(cookie: CookieInput): string {
  if (typeof cookie.url === "string" && cookie.url) return cookie.url;
  const domain = String(cookie.domain || "www.figma.com").replace(/^\./, "");
  const secure = cookie.secure !== false;
  return `${secure ? "https" : "http"}://${domain}${cookie.path || "/"}`;
}

async function applyCookies(cookies: CookieInput[]): Promise<{ ok: true; count: number }> {
  const ses = session.defaultSession;
  // Remove the engine's previous Figma session first. Otherwise cookies for
  // another account/domain variant can survive the handoff and make an
  // editable file look view-only in the embedded engine.
  const existing = await ses.cookies.get({ url: HOMEPAGE });
  for (const cookie of existing) {
    try {
      await ses.cookies.remove(cookieSetUrl(cookie), cookie.name);
    } catch {
      /* A cookie can disappear while the page navigates; continue copying. */
    }
  }
  let count = 0;
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") continue;
    const details: Electron.CookiesSetDetails = {
      url: cookieSetUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: cookie.secure !== false,
      httpOnly: !!cookie.httpOnly,
    };
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    if (cookie.sameSite) details.sameSite = cookie.sameSite;
    // __Host- cookies are host-only — Electron rejects a domain attribute.
    if (!cookie.name.startsWith("__Host-") && cookie.domain) {
      details.domain = cookie.domain;
    }
    await ses.cookies.set(details);
    count += 1;
  }
  return { ok: true, count };
}

async function hasFigmaSessionCookie(): Promise<boolean> {
  const cookies = await session.defaultSession.cookies.get({ url: HOMEPAGE });
  return cookies.some((cookie) => cookie.name === FIGMA_SESSION_COOKIE_NAME);
}

export function startEngineControl(deps: EngineControlDeps): http.Server {
  app.on("before-quit", () => {
    markEngineProcessQuitting();
  });
  const port = engineControlPort();
  const server = http.createServer((req, res) => {
    const host = req.socket.remoteAddress || "";
    if (host !== "127.0.0.1" && host !== "::1" && host !== "::ffff:127.0.0.1") {
      json(res, 403, { ok: false, error: "loopback only" });
      return;
    }

    void (async () => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (url.pathname === "/status" && (!req.method || req.method === "GET")) {
          const window = deps.windowManager.getLastFocusedWindow();
          let currentUrl = "";
          let loading = false;
          if (window) {
            try {
              const tabId = window.getLatestFocusedTabId();
              const tab = window.getTabInfo(tabId);
              currentUrl = tab?.url || "";
              const webContents =
                window.tabs.get(tabId)?.view?.webContents ?? window.win?.webContents;
              loading = !!webContents?.isLoading();
            } catch {
              /* tab vanished mid-read — report empty url, not a 500 */
            }
          }
          const pluginMenu = deps.windowManager.describePluginMenu(ENGINE_PLUGIN_NAME);
          json(res, 200, {
            ok: true,
            authed: await hasFigmaSessionCookie(),
            currentUrl,
            loading,
            currentFileKey: parseFigmaFileKey(currentUrl),
            windowVisible: isEngineWindowVisible(),
            pluginPath: enginePluginPath(),
            hasPluginMenu: pluginMenu.matched,
            pluginMenuTabs: pluginMenu.tabs,
            pluginMenuAgeMs: pluginMenu.ageMs,
            pluginMenuLabels: pluginMenu.labels,
            pluginMenuAction: pluginMenu.matchedAction,
          });
          return;
        }

        if (url.pathname === "/rpc" && req.method === "POST") {
          const payload = JSON.parse((await readBody(req)) || "{}") as {
            method?: string;
            params?: Record<string, unknown>;
          };
          const method = payload.method;
          const params = payload.params || {};

          if (method === "openUrl") {
            const target = String(params.url || "");
            if (!target) {
              json(res, 400, { ok: false, error: "url required" });
              return;
            }
            deps.windowManager.openUrl(target);
            json(res, 200, { ok: true });
            return;
          }

          if (method === "ensureRuntime") {
            ensureEngineRuntime(deps.windowManager);
            json(res, 200, { ok: true, windowVisible: isEngineWindowVisible() });
            return;
          }

          if (method === "runPlugin") {
            const name = String(params.name || ENGINE_PLUGIN_NAME);
            const fileKey = typeof params.fileKey === "string" ? params.fileKey : undefined;
            const ran = deps.windowManager.runPluginByName(name, fileKey);
            json(res, 200, {
              ok: ran,
              error: ran ? undefined : `plugin menu item not ready: ${name}`,
            });
            return;
          }

          if (method === "setCookies") {
            const cookies = Array.isArray(params.cookies) ? (params.cookies as CookieInput[]) : [];
            const result = await applyCookies(cookies);
            json(res, 200, result);
            return;
          }

          if (method === "hasSession") {
            json(res, 200, { ok: true, authed: await hasFigmaSessionCookie() });
            return;
          }

          if (method === "redeemAuth") {
            const target = String(params.url || "");
            const ok = deps.windowManager.tryHandleAppAuthRedeemUrl(target);
            json(res, 200, { ok });
            return;
          }

          // Invisible prime: the Figma SPA only loads local dev plugins (and
          // pushes its full plugin menu) once its window has been shown.
          // Map the window at opacity 0 without focus, wait for the menu,
          // then hide again — nothing ever reaches the screen.
          if (method === "primeWindow") {
            const window = deps.windowManager.getLastFocusedWindow();
            if (!window || window.win.isDestroyed()) {
              json(res, 200, { ok: false, error: "no window" });
              return;
            }
            const win = window.win;
            const wasVisible = isEngineWindowVisible();
            const keepInvisible = params.keepInvisible === true;
            const targetTab = window.getTabInfo(window.getLatestFocusedTabId());
            const targetFileKey = parseFigmaFileKey(targetTab?.url || "");
            const deadline = Date.now() + 12000;
            if (!wasVisible) {
              await startEngineWindowPrime(win);
            }
            let primed = false;
            let matchedSince = 0;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 400));
              const menuReady = targetFileKey
                ? !!deps.windowManager.findPluginMenuAction(ENGINE_PLUGIN_NAME, targetFileKey)
                : deps.windowManager.describePluginMenu(ENGINE_PLUGIN_NAME).matched;
              const loading = !!window.tabs
                .get(window.getLatestFocusedTabId())
                ?.view?.webContents?.isLoading?.();
              if (menuReady && !loading) {
                if (!matchedSince) matchedSince = Date.now();
                if (Date.now() - matchedSince < 1200) continue;
                primed = true;
                break;
              }
              matchedSince = 0;
            }
            if (!wasVisible && !keepInvisible) {
              finishEngineWindowPrime(win);
            }
            json(res, 200, {
              ok: true,
              primed,
              kept: wasVisible,
              keptInvisible: !wasVisible && keepInvisible,
            });
            return;
          }

          if (method === "show") {
            await applyWindowVisibility(deps.windowManager, true);
            json(res, 200, { ok: true, windowVisible: true });
            return;
          }

          if (method === "hide") {
            await applyWindowVisibility(deps.windowManager, false);
            json(res, 200, { ok: true, windowVisible: false });
            return;
          }

          json(res, 400, { ok: false, error: `unknown method: ${method}` });
          return;
        }

        json(res, 404, { ok: false, error: "not found" });
      } catch (error) {
        logger.error("[engine-control]", error);
        json(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info(`[engine-control] listening on 127.0.0.1:${port}`);
  });
  return server;
}
