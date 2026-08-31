import type {
  BridgeConfigSnapshot,
  BridgeConfigUpdate,
  BridgeConnectionInfo,
  BridgeStatus,
} from '../types.js';

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPaneSnapshot {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string | undefined;
}

export interface BrowserHostSnapshot {
  available: boolean;
  reason?: string | undefined;
  unavailableReasonCode?: 'electron-unavailable' | 'main-window-unavailable' | undefined;
  panes: BrowserPaneSnapshot[];
}

export interface BridgeControlSnapshot {
  bridge: BridgeStatus;
  configuration: BridgeConfigSnapshot;
  browser: BrowserHostSnapshot;
}

export type BrowserNavigationAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop';

export type BridgeControlAction =
  | { action: 'bridge.start'; workspaceId: string }
  | { action: 'bridge.stop'; workspaceId: string }
  | { action: 'bridge.reset'; workspaceId: string }
  | { action: 'bridge.connection'; workspaceId: string }
  | { action: 'bridge.config.get'; workspaceId: string }
  | { action: 'bridge.config.update'; workspaceId: string; update: BridgeConfigUpdate }
  | {
    action: 'browser.open' | 'browser.navigate';
    workspaceId: string;
    paneId: string;
    url: string;
  }
  | {
    action: `browser.${BrowserNavigationAction}`;
    workspaceId: string;
    paneId: string;
  }
  | {
    action: 'browser.close';
    workspaceId: string;
    paneId: string;
  }
  | {
    action: 'browser.bounds';
    workspaceId: string;
    panes: Array<{ id: string; bounds: BrowserBounds }>;
  }
  | { action: 'browser.hide'; workspaceId: string };

export interface BridgeControlSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface BridgeControlFailure {
  ok: false;
  error: string;
}

export type BridgeControlResponse<T = unknown> =
  | BridgeControlSuccess<T>
  | BridgeControlFailure;

export type BridgeConnectionResponse = BridgeConnectionInfo;
