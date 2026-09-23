import http from "node:http";
import { app, session, type BrowserWindow, type Rectangle, type WebContents } from "electron";

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
let windowEverShown = false;
let savedBounds: Rectangle | null = null;
let engineProcessQuitting = false;

export function isEngineWindowVisible(): boolean {
  return windowVisible;
}

export function setEngineWindowVisible(visible: boolean): void {
  windowVisible = visible;
}

/** Diagnostic only: background operation never maps the native window. */
export function engineWindowEverShown(): boolean {
  return windowEverShown;
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

/** Report actual native window visibility, including unexpected reveals. */
export function trackEngineWindowVisibility(win: BrowserWindow): void {
  win.on("show", () => {
    windowEverShown = true;
    setEngineWindowVisible(true);
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
  rememberBounds(win);
  win.setSkipTaskbar(true);
  if (win.isVisible()) win.hide();
}

const backgroundRenderers = new WeakMap<WebContents, Promise<void>>();

/** Activate the page's focus/visibility lifecycle without showing or focusing
 *  a native window. Keep the CDP session attached while the renderer lives. */
export function prepareEngineWebContents(contents: WebContents): Promise<void> {
  if (!isMinFigmaEngine() || contents.isDestroyed()) return Promise.resolve();
  const pending = backgroundRenderers.get(contents);
  if (pending) return pending;
  contents.setBackgroundThrottling(false);
  const ready = (async () => {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  })();
  backgroundRenderers.set(contents, ready);
  contents.debugger.once("detach", () => backgroundRenderers.delete(contents));
  void ready.catch(() => backgroundRenderers.delete(contents));
  return ready;
}

export async function engineDesktopReady(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed() || contents.isLoading()) return false;
  try {
    await prepareEngineWebContents(contents);
    const result = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: "window.__minFigmaDesktopReady === true",
      returnByValue: true,
    });
    return result.result?.value === true;
  } catch {
    return false;
  }
}

export async function ensureEngineRuntime(
  windowManager: WindowManager,
  fileKey?: string,
): Promise<boolean> {
  const window = windowManager.getLastFocusedWindow();
  if (!window || window.win.isDestroyed()) return false;
  const tab = fileKey
    ? [...window.tabs.values()].find((tab) => parseFigmaFileKey(tab.getUrl()) === fileKey)
    : window.tabs.get(window.getLatestFocusedTabId());
  if (!tab || tab.view.webContents.isDestroyed()) return false;
  // Select the child view and give it real bounds; the BrowserWindow stays hidden.
  if (window.getLatestFocusedTabId() !== tab.id) window.setTabFocus(tab.id);
  window.updateTabsBounds();
  return engineDesktopReady(tab.view.webContents);
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
          let runtimeReady = false;
          if (window) {
            try {
              const tabId = window.getLatestFocusedTabId();
              const tab = window.getTabInfo(tabId);
              currentUrl = tab?.url || "";
              const webContents =
                window.tabs.get(tabId)?.view?.webContents ?? window.win?.webContents;
              loading = !!webContents?.isLoading();
              if (parseFigmaFileKey(currentUrl) && webContents) {
                runtimeReady = await engineDesktopReady(webContents);
              }
            } catch {
              /* tab vanished mid-read — report empty url, not a 500 */
            }
          }
          const pluginMenu = deps.windowManager.describePluginMenu(ENGINE_PLUGIN_NAME);
          json(res, 200, {
            ok: true,
            authed: await hasFigmaSessionCookie(),
            backgroundRuntime: true,
            runtimeReady,
            currentUrl,
            loading,
            currentFileKey: parseFigmaFileKey(currentUrl),
            windowVisible: isEngineWindowVisible(),
            everShown: engineWindowEverShown(),
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
            const fileKey = typeof params.fileKey === "string" ? params.fileKey : undefined;
            const ready = await ensureEngineRuntime(deps.windowManager, fileKey);
            json(res, 200, {
              ok: ready,
              error: ready ? undefined : "Figma editor is still starting in the background",
              windowVisible: isEngineWindowVisible(),
            });
            return;
          }

          if (method === "runPlugin") {
            const name = String(params.name || ENGINE_PLUGIN_NAME);
            const fileKey = typeof params.fileKey === "string" ? params.fileKey : undefined;
            const ready = await ensureEngineRuntime(deps.windowManager, fileKey);
            const ran = ready && deps.windowManager.runPluginByName(name, fileKey);
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
