import { createRequire } from 'node:module';
import type {
  BrowserBounds,
  BrowserHostSnapshot,
  BrowserNavigationAction,
  BrowserPaneSnapshot,
} from './types.js';

const require = createRequire(import.meta.url);
const DEFAULT_PARTITION = 'persist:dsh-browser-bridge';
const MAX_WORKSPACES = 16;

interface NativeNavigationHistory {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
}

interface NativeWebContents {
  readonly navigationHistory?: NativeNavigationHistory | undefined;
  getURL(): string;
  getTitle(): string;
  getZoomFactor?(): number;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  reload(): void;
  stop(): void;
  close(): void;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'allow' | 'deny' },
  ): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
}

interface NativeContentView {
  addChildView(view: NativeWebContentsView): void;
  removeChildView(view: NativeWebContentsView): void;
}

interface NativeBrowserWindow {
  readonly contentView: NativeContentView;
  readonly webContents: NativeWebContents;
  isDestroyed(): boolean;
  isVisible(): boolean;
  getContentBounds(): { width: number; height: number };
}

interface NativeWebContentsView {
  readonly webContents: NativeWebContents;
  setBackgroundColor(color: string): void;
  setBounds(bounds: BrowserBounds): void;
}

interface ElectronModuleLike {
  BrowserWindow: {
    getAllWindows(): NativeBrowserWindow[];
  };
  WebContentsView: new (options: {
    webPreferences: {
      partition: string;
      sandbox: boolean;
      contextIsolation: boolean;
      nodeIntegration: boolean;
      webSecurity: boolean;
      allowRunningInsecureContent: boolean;
    };
  }) => NativeWebContentsView;
}

export type ElectronLoader = () => Promise<ElectronModuleLike>;

interface BrowserPane {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string | undefined;
  view: NativeWebContentsView;
  window?: NativeBrowserWindow | undefined;
}

function loadElectronModule(): Promise<ElectronModuleLike> {
  if (!process.versions.electron) {
    throw new Error('Embedded browser requires the dsh Desktop Electron runtime');
  }
  return Promise.resolve(require('electron') as ElectronModuleLike);
}

function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Browser URL is required');
  }
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS browser URLs are allowed');
  }
  return parsed.href;
}

function finiteBounds(bounds: BrowserBounds): BrowserBounds {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every(Number.isFinite)) {
    throw new Error('Browser bounds must contain finite numbers');
  }
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function paneSnapshot(pane: BrowserPane): BrowserPaneSnapshot {
  return {
    id: pane.id,
    title: pane.title,
    url: pane.url,
    loading: pane.loading,
    canGoBack: pane.canGoBack,
    canGoForward: pane.canGoForward,
    ...(pane.error === undefined ? {} : { error: pane.error }),
  };
}

export class DesktopBrowserHost {
  private readonly workspaces = new Map<string, Map<string, BrowserPane>>();
  private electronPromise: Promise<ElectronModuleLike> | undefined;
  private unavailableReason: string | undefined;

  constructor(
    private readonly expectedPort: number,
    private readonly partition = DEFAULT_PARTITION,
    private readonly loadElectron: ElectronLoader = loadElectronModule,
  ) {}

  async snapshot(workspaceId: string): Promise<BrowserHostSnapshot> {
    const electron = await this.electron();
    if (!electron) {
      return {
        available: false,
        reason: this.unavailableReason ?? 'Electron desktop runtime is unavailable',
        unavailableReasonCode: 'electron-unavailable',
        panes: [],
      };
    }
    const panes = this.workspaces.get(workspaceId);
    const mainWindow = this.findMainWindow(electron);
    return {
      available: mainWindow !== undefined,
      ...(mainWindow === undefined
        ? {
          reason: 'The dsh Desktop main window is not ready',
          unavailableReasonCode: 'main-window-unavailable' as const,
        }
        : {}),
      panes: panes ? [...panes.values()].map(paneSnapshot) : [],
    };
  }

  async open(
    workspaceId: string,
    paneId: string,
    rawUrl: string,
  ): Promise<BrowserPaneSnapshot> {
    const url = normalizeBrowserUrl(rawUrl);
    const electron = await this.requireElectron();
    const mainWindow = this.requireMainWindow(electron);
    const panes = this.workspace(workspaceId);
    let pane = panes.get(paneId);
    if (!pane) {
      pane = this.createPane(electron, workspaceId, paneId, url);
      panes.set(paneId, pane);
    }
    this.attach(pane, mainWindow);
    pane.error = undefined;
    if (pane.view.webContents.getURL() !== url) {
      pane.url = url;
      pane.loading = true;
      void pane.view.webContents.loadURL(url).catch((error: unknown) => {
        pane.loading = false;
        pane.error = error instanceof Error ? error.message : String(error);
      });
    }
    this.refreshPane(pane);
    return paneSnapshot(pane);
  }

  async navigate(workspaceId: string, paneId: string, url: string): Promise<BrowserPaneSnapshot> {
    return this.open(workspaceId, paneId, url);
  }

  async navigation(
    workspaceId: string,
    paneId: string,
    action: BrowserNavigationAction,
  ): Promise<BrowserPaneSnapshot> {
    const pane = this.requirePane(workspaceId, paneId);
    const contents = pane.view.webContents;
    const history = contents.navigationHistory;
    if (action === 'back') {
      if (history?.canGoBack()) history.goBack();
    } else if (action === 'forward') {
      if (history?.canGoForward()) history.goForward();
    } else if (action === 'reload') {
      contents.reload();
    } else {
      contents.stop();
    }
    this.refreshPane(pane);
    return paneSnapshot(pane);
  }

  async setBounds(
    workspaceId: string,
    visiblePanes: Array<{ id: string; bounds: BrowserBounds }>,
  ): Promise<BrowserHostSnapshot> {
    const normalizedPanes = visiblePanes.map((item) => ({
      id: item.id,
      bounds: finiteBounds(item.bounds),
    }));
    const electron = await this.requireElectron();
    const mainWindow = this.requireMainWindow(electron);
    const panes = this.workspaces.get(workspaceId);
    if (!panes) {
      return this.snapshot(workspaceId);
    }
    const visible = new Set(normalizedPanes.map(({ id }) => id));
    for (const pane of panes.values()) {
      if (!visible.has(pane.id)) this.detach(pane);
    }
    const zoomFactor = mainWindow.webContents.getZoomFactor?.() ?? 1;
    for (const item of normalizedPanes) {
      const pane = panes.get(item.id);
      if (!pane) continue;
      this.attach(pane, mainWindow);
      pane.view.setBounds({
        x: Math.round(item.bounds.x * zoomFactor),
        y: Math.round(item.bounds.y * zoomFactor),
        width: Math.round(item.bounds.width * zoomFactor),
        height: Math.round(item.bounds.height * zoomFactor),
      });
    }
    return this.snapshot(workspaceId);
  }

  async hide(workspaceId: string): Promise<void> {
    const panes = this.workspaces.get(workspaceId);
    if (!panes) return;
    for (const pane of panes.values()) this.detach(pane);
  }

  async close(workspaceId: string, paneId: string): Promise<void> {
    const panes = this.workspaces.get(workspaceId);
    const pane = panes?.get(paneId);
    if (!pane) return;
    this.destroyPane(pane);
    panes!.delete(paneId);
    if (panes!.size === 0) this.workspaces.delete(workspaceId);
  }

  async dispose(): Promise<void> {
    for (const panes of this.workspaces.values()) {
      for (const pane of panes.values()) this.destroyPane(pane);
    }
    this.workspaces.clear();
  }

  private async electron(): Promise<ElectronModuleLike | undefined> {
    if (this.unavailableReason) return undefined;
    this.electronPromise ??= this.loadElectron();
    try {
      return await this.electronPromise;
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  private async requireElectron(): Promise<ElectronModuleLike> {
    const electron = await this.electron();
    if (!electron) {
      throw new Error(this.unavailableReason ?? 'Electron desktop runtime is unavailable');
    }
    return electron;
  }

  private findMainWindow(electron: ElectronModuleLike): NativeBrowserWindow | undefined {
    const windows = electron.BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed());
    const matching = windows.filter((window) => {
      try {
        const url = new URL(window.webContents.getURL());
        return Number(url.port) === this.expectedPort
          && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
      } catch {
        return false;
      }
    });
    const candidates = matching.length > 0 ? matching : windows;
    return candidates
      .filter((window) => window.isVisible())
      .sort((left, right) => {
        const leftBounds = left.getContentBounds();
        const rightBounds = right.getContentBounds();
        return (rightBounds.width * rightBounds.height) - (leftBounds.width * leftBounds.height);
      })
      .at(0);
  }

  private requireMainWindow(electron: ElectronModuleLike): NativeBrowserWindow {
    const window = this.findMainWindow(electron);
    if (!window) {
      throw new Error('The dsh Desktop main window is not ready');
    }
    return window;
  }

  private workspace(workspaceId: string): Map<string, BrowserPane> {
    let workspace = this.workspaces.get(workspaceId);
    if (workspace) return workspace;
    if (this.workspaces.size >= MAX_WORKSPACES) {
      const oldest = this.workspaces.keys().next().value as string | undefined;
      if (oldest) {
        const panes = this.workspaces.get(oldest);
        if (panes) {
          for (const pane of panes.values()) this.destroyPane(pane);
        }
        this.workspaces.delete(oldest);
      }
    }
    workspace = new Map();
    this.workspaces.set(workspaceId, workspace);
    return workspace;
  }

  private createPane(
    electron: ElectronModuleLike,
    workspaceId: string,
    id: string,
    url: string,
  ): BrowserPane {
    const view = new electron.WebContentsView({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const pane: BrowserPane = {
      id,
      title: new URL(url).hostname,
      url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      view,
    };
    const refresh = () => this.refreshPane(pane);
    view.webContents.on('did-start-loading', () => {
      pane.loading = true;
      pane.error = undefined;
      refresh();
    });
    view.webContents.on('did-stop-loading', () => {
      pane.loading = false;
      refresh();
    });
    view.webContents.on('did-navigate', refresh);
    view.webContents.on('did-navigate-in-page', refresh);
    view.webContents.on('page-title-updated', refresh);
    view.webContents.on('did-fail-load', (...args) => {
      const errorDescription = typeof args[2] === 'string' ? args[2] : 'Page load failed';
      const isMainFrame = typeof args[4] === 'boolean' ? args[4] : true;
      if (isMainFrame) pane.error = errorDescription;
      pane.loading = false;
      refresh();
    });
    view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      try {
        const normalized = normalizeBrowserUrl(popupUrl);
        const panes = this.workspaces.get(workspaceId) ?? this.workspace(workspaceId);
        const popupId = `pane-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const popup = this.createPane(electron, workspaceId, popupId, normalized);
        panes.set(popupId, popup);
        this.attach(popup, this.requireMainWindow(electron));
        void popup.view.webContents.loadURL(normalized);
      } catch {
        // Non-web popup targets stay denied.
      }
      return { action: 'deny' };
    });
    return pane;
  }

  private refreshPane(pane: BrowserPane): void {
    if (pane.view.webContents.isDestroyed()) return;
    const url = pane.view.webContents.getURL();
    const title = pane.view.webContents.getTitle();
    const history = pane.view.webContents.navigationHistory;
    if (url) pane.url = url;
    if (title) pane.title = title;
    pane.canGoBack = history?.canGoBack() ?? false;
    pane.canGoForward = history?.canGoForward() ?? false;
  }

  private requirePane(workspaceId: string, paneId: string): BrowserPane {
    const pane = this.workspaces.get(workspaceId)?.get(paneId);
    if (!pane) throw new Error(`Unknown browser pane "${paneId}"`);
    return pane;
  }

  private attach(pane: BrowserPane, window: NativeBrowserWindow): void {
    if (pane.window === window) return;
    this.detach(pane);
    window.contentView.addChildView(pane.view);
    pane.window = window;
  }

  private detach(pane: BrowserPane): void {
    if (!pane.window || pane.window.isDestroyed()) {
      pane.window = undefined;
      return;
    }
    pane.window.contentView.removeChildView(pane.view);
    pane.window = undefined;
  }

  private destroyPane(pane: BrowserPane): void {
    this.detach(pane);
    pane.view.webContents.removeAllListeners();
    if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close();
  }
}
