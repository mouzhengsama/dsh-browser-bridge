import { describe, expect, it, vi } from 'vitest';
import {
  DesktopBrowserHost,
  type ElectronLoader,
} from '../src/browser/desktop-host.js';

type Listener = (...args: unknown[]) => void;

class FakeWebContents {
  private destroyed = false;
  private readonly listeners = new Map<string, Listener[]>();
  private popupHandler:
    | ((details: { url: string }) => { action: 'allow' | 'deny' })
    | undefined;
  private url = '';
  private title = '';
  readonly loadedUrls: string[] = [];
  readonly navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  getZoomFactor(): number {
    return 1.25;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  async loadURL(url: string): Promise<void> {
    this.url = url;
    this.loadedUrls.push(url);
    this.emit('did-start-loading');
    this.emit('did-stop-loading');
  }

  reload(): void {
    this.emit('did-start-loading');
    this.emit('did-stop-loading');
  }

  stop(): void {
    this.emit('did-stop-loading');
  }

  close(): void {
    this.destroyed = true;
  }

  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'allow' | 'deny' },
  ): void {
    this.popupHandler = handler;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  openPopup(url: string): { action: 'allow' | 'deny' } {
    if (!this.popupHandler) throw new Error('No popup handler registered');
    return this.popupHandler({ url });
  }
}

class FakeWebContentsView {
  static readonly instances: FakeWebContentsView[] = [];
  readonly webContents = new FakeWebContents();
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  backgroundColor = '';
  readonly partition: string;

  constructor(options: { webPreferences: { partition: string } }) {
    this.partition = options.webPreferences.partition;
    FakeWebContentsView.instances.push(this);
  }

  setBackgroundColor(color: string): void {
    this.backgroundColor = color;
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }
}

class FakeBrowserWindow {
  readonly children = new Set<FakeWebContentsView>();
  readonly contentView = {
    addChildView: (view: FakeWebContentsView) => {
      this.children.add(view);
    },
    removeChildView: (view: FakeWebContentsView) => {
      this.children.delete(view);
    },
  };
  readonly webContents = new FakeWebContents();
  private destroyed = false;

  constructor(
    private readonly url: string,
    private readonly visible: boolean,
    private readonly width: number,
    private readonly height: number,
    private readonly zoomFactor = 1.25,
  ) {
    void this.webContents.loadURL(url);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  getContentBounds(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  destroy(): void {
    this.destroyed = true;
  }

  getZoomFactor(): number {
    return this.zoomFactor;
  }
}

function createElectronLoader(
  expectedPort: number,
  windows: FakeBrowserWindow[],
): ElectronLoader {
  return async () => ({
    BrowserWindow: {
      getAllWindows: () => windows,
    },
    WebContentsView: FakeWebContentsView,
  }) as never;
}

describe('DesktopBrowserHost', () => {
  it('reports that Electron is required outside the desktop runtime', async () => {
    const host = new DesktopBrowserHost(48271, undefined, async () => {
      throw new Error('Embedded browser requires the dsh Desktop Electron runtime');
    });

    await expect(host.snapshot('workspace-a')).resolves.toMatchObject({
      available: false,
      reason: 'Embedded browser requires the dsh Desktop Electron runtime',
      panes: [],
    });
  });

  it('uses the persistent partition and supports more than two panes', async () => {
    FakeWebContentsView.instances.length = 0;
    const mainWindow = new FakeBrowserWindow(
      'http://127.0.0.1:48271/',
      true,
      1600,
      900,
    );
    const host = new DesktopBrowserHost(
      48271,
      undefined,
      createElectronLoader(48271, [mainWindow]),
    );

    await host.open('workspace-a', 'pane-1', 'example.com/one');
    await host.open('workspace-a', 'pane-2', 'https://example.org/two');

    expect(FakeWebContentsView.instances.map((view) => view.partition)).toEqual([
      'persist:dsh-browser-bridge',
      'persist:dsh-browser-bridge',
    ]);
    await host.open('workspace-a', 'pane-3', 'https://example.net/three');
    await host.open('workspace-a', 'pane-8', 'https://example.dev/eight');

    expect(FakeWebContentsView.instances.map((view) => view.partition)).toEqual([
      'persist:dsh-browser-bridge',
      'persist:dsh-browser-bridge',
      'persist:dsh-browser-bridge',
      'persist:dsh-browser-bridge',
    ]);
    expect((await host.snapshot('workspace-a')).panes).toHaveLength(4);
    expect([...mainWindow.children]).toHaveLength(4);
  });

  it('normalizes web URLs and routes web popups into the current pane', async () => {
    const mainWindow = new FakeBrowserWindow(
      'http://127.0.0.1:48272/',
      true,
      1000,
      800,
    );
    const host = new DesktopBrowserHost(
      48272,
      undefined,
      createElectronLoader(48272, [mainWindow]),
    );

    await host.open('workspace-b', 'pane-1', 'example.com/start');
    const sourceView = FakeWebContentsView.instances.at(-1)!;
    expect(sourceView.webContents.loadedUrls).toContain('https://example.com/start');
    expect(sourceView.webContents.openPopup('https://example.com/popup')).toEqual({ action: 'deny' });
    const popupView = FakeWebContentsView.instances.at(-1)!;
    expect(popupView).not.toBe(sourceView);
    expect(popupView.webContents.loadedUrls.at(-1)).toBe('https://example.com/popup');
    const snapshot = await host.snapshot('workspace-b');
    expect(snapshot.panes.map((pane) => pane.url)).toContain('https://example.com/popup');
    await expect(host.open('workspace-b', 'pane-2', 'file:///tmp/secret'))
      .rejects.toThrow('Only HTTP and HTTPS');
  });

  it('clips and converts bounds using the main window zoom factor', async () => {
    const mainWindow = new FakeBrowserWindow(
      'http://127.0.0.1:48273/',
      true,
      1000,
      800,
      1.25,
    );
    const host = new DesktopBrowserHost(
      48273,
      undefined,
      createElectronLoader(48273, [mainWindow]),
    );

    await host.open('workspace-c', 'pane-1', 'https://example.com');
    await host.setBounds('workspace-c', [{
      id: 'pane-1',
      bounds: { x: -2.2, y: 2.6, width: 300.4, height: 4.4 },
    }]);

    const view = FakeWebContentsView.instances.at(-1)!;
    expect(view.bounds).toEqual({
      x: 0,
      y: 4,
      width: 375,
      height: 5,
    });
  });

  it('chooses the largest visible dsh window and cleans up panes', async () => {
    const hiddenMatching = new FakeBrowserWindow(
      'http://127.0.0.1:48274/',
      false,
      3000,
      2000,
    );
    const smallMatching = new FakeBrowserWindow(
      'http://127.0.0.1:48274/',
      true,
      800,
      600,
    );
    const largeMatching = new FakeBrowserWindow(
      'http://127.0.0.1:48274/',
      true,
      1400,
      900,
    );
    const unrelated = new FakeBrowserWindow(
      'http://127.0.0.1:49100/',
      true,
      4000,
      3000,
    );
    const host = new DesktopBrowserHost(
      48274,
      undefined,
      createElectronLoader(48274, [
        hiddenMatching,
        smallMatching,
        largeMatching,
        unrelated,
      ]),
    );

    await host.open('workspace-d', 'pane-1', 'https://example.com');
    expect(largeMatching.children).toHaveLength(1);
    expect(smallMatching.children).toHaveLength(0);
    expect(unrelated.children).toHaveLength(0);

    await host.open('workspace-d', 'pane-2', 'https://example.org');
    await host.hide('workspace-d');
    expect(largeMatching.children).toHaveLength(0);
    await host.close('workspace-d', 'pane-1');
    expect(FakeWebContentsView.instances.at(-2)?.webContents.isDestroyed()).toBe(true);
    await host.dispose();
    expect(FakeWebContentsView.instances.at(-1)?.webContents.isDestroyed()).toBe(true);
    expect((await host.snapshot('workspace-d')).panes).toEqual([]);
  });

  it('reports an unavailable desktop runtime without throwing on snapshot', async () => {
    const host = new DesktopBrowserHost(
      48275,
      undefined,
      async () => {
        throw new Error('electron unavailable');
      },
    );

    await expect(host.snapshot('workspace-e')).resolves.toMatchObject({
      available: false,
      reason: 'electron unavailable',
      panes: [],
    });
  });
});
