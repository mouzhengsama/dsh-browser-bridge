import type { Context } from '@deepseek-ai/cordis';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Columns2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Globe2,
  House,
  Link2,
  LockKeyhole,
  LoaderCircle,
  PanelTop,
  Play,
  Plus,
  Power,
  RotateCw,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  BridgeControlAction,
  BridgeControlResponse,
  BridgeControlSnapshot,
  BrowserBounds,
  BrowserPaneSnapshot,
} from './browser/types.js';
import { CLIENT_STYLE, CLIENT_STYLE_ID } from './client-style.js';
import {
  BUILT_IN_LINKS,
  BUILT_IN_ORIGINS,
  type BuiltInLink,
} from './links.js';
import type {
  BridgeConfigSnapshot,
  BridgeConfigUpdate,
  BridgeConnectionInfo,
  BridgeStatus,
  OAuthPairingCode,
} from './types.js';

const CONTROL_PATH = '/browser-bridge/control';
const QUICK_LINK_STORAGE = 'dsh.browserBridge.quickLinks';
const LAYOUT_STORAGE = 'dsh.browserBridge.layout';
const DEFAULT_PAGE = 'https://chatgpt.com';

interface QuickLink extends BuiltInLink {}

type LayoutMode = 'single' | 'split';

interface WorkspaceViewLike {
  workspaceId: string;
  sessionIds: readonly string[];
}

interface WorkspaceSnapshotLike {
  items: readonly WorkspaceViewLike[];
}

interface BrowserBridgeViewProps {
  sessionId: string;
  useWorkspaces: <Selected>(
    selector: (snapshot: WorkspaceSnapshotLike) => Selected,
  ) => Selected;
}

interface ClientSlots {
  inject(name: string, register: () => unknown): unknown;
  register(
    options: {
      name: string;
      id: string;
      order: number;
      label: string;
    },
    component: ComponentType<BrowserBridgeViewProps>,
  ): () => void;
}

interface ClientContext extends Context {
  slots: ClientSlots;
}

export const name = 'dsh-browser-bridge-client';
export const inject = ['slots'] as const;

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const existing = document.getElementById(CLIENT_STYLE_ID);
  if (existing) return () => undefined;
  const style = document.createElement('style');
  style.id = CLIENT_STYLE_ID;
  style.dataset.plugin = '@dsh/browser-bridge';
  style.textContent = CLIENT_STYLE;
  document.head.append(style);
  return () => {
    style.remove();
  };
}

export function apply(ctx: Context): void {
  const client = ctx as ClientContext;
  client.effect(() => installStyles(), `${name}: styles`);
  client.slots.inject('conversation.view', () => client.slots.register({
    name: 'conversation.view',
    id: 'browser-bridge',
    order: 100,
    label: 'Bridge',
  }, BrowserBridgeView));
}

async function readControlResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as BridgeControlResponse<T>;
  if (!response.ok || !body.ok) {
    throw new Error(body.ok ? `Bridge control failed with HTTP ${response.status}` : body.error);
  }
  return body.data;
}

async function fetchSnapshot(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<BridgeControlSnapshot> {
  const query = new URLSearchParams({ workspaceId });
  const response = await fetch(`${CONTROL_PATH}/snapshot?${query}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  });
  return readControlResponse<BridgeControlSnapshot>(response);
}

async function postAction<T>(action: BridgeControlAction): Promise<T> {
  const response = await fetch(`${CONTROL_PATH}/action`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(action),
  });
  return readControlResponse<T>(response);
}

async function postActionWithTimeout<T>(
  action: BridgeControlAction,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${CONTROL_PATH}/action`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(action),
      signal: controller.signal,
    });
    return await readControlResponse<T>(response);
  } finally {
    window.clearTimeout(timer);
  }
}

function normalizeWebUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('请输入网页地址');
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('只允许打开 HTTP 或 HTTPS 地址');
  }
  return url.href;
}

function loadQuickLinks(): QuickLink[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(QUICK_LINK_STORAGE) ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): QuickLink[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (
        typeof record.id !== 'string'
        || typeof record.name !== 'string'
        || typeof record.url !== 'string'
      ) {
        return [];
      }
      try {
        return [{
          id: record.id,
          name: record.name,
          url: normalizeWebUrl(record.url),
          color: typeof record.color === 'string' ? record.color : '#69717d',
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function initialLayout(): LayoutMode {
  return typeof localStorage !== 'undefined' && localStorage.getItem(LAYOUT_STORAGE) === 'split'
    ? 'split'
    : 'single';
}

function createQuickLinkId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createPaneId(panes: readonly BrowserPaneSnapshot[]): string {
  let index = panes.length + 1;
  let id = `pane-${index}`;
  const used = new Set(panes.map(pane => pane.id));
  while (used.has(id)) {
    index += 1;
    id = `pane-${index}`;
  }
  return id;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('浏览器拒绝了剪贴板写入');
}

function connectionPrompt(info: BridgeConnectionInfo): string {
  if (!info.mcpUrl) throw new Error('Bridge 尚未返回可用的 MCP 地址');
  const lines = [
    `MCP URL: ${info.mcpUrl}`,
    ...(info.bearerToken ? [`Authorization: Bearer ${info.bearerToken}`] : []),
    '',
    '快速连接这个 Streamable HTTP MCP，明确使用规则，熟悉可用工具，做好处理接下来一系列工作的准备。',
  ];
  return lines.join('\n');
}

function stateLabel(state: BridgeStatus['state'] | undefined): string {
  if (state === 'running') return '运行中';
  if (state === 'starting') return '启动中';
  if (state === 'stopping') return '停止中';
  if (state === 'failed') return '启动失败';
  return '已停止';
}

function originLabel(status: BridgeStatus | undefined): string {
  const origin = status?.publicOrigin
    ?? (status?.tunnelProvider === 'none' ? status.localOrigin : undefined);
  if (!origin) {
    return status?.tunnelProvider === 'none' ? '本机模式尚未启动' : '尚未建立连接';
  }
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function tunnelLabel(provider: BridgeStatus['tunnelProvider'] | undefined): string {
  if (provider === 'cloudflare') return 'Cloudflare Quick Tunnel';
  if (provider === 'cloudflare-named') return 'Cloudflare Named Tunnel';
  if (provider === 'ngrok') return 'ngrok 开发域名';
  if (provider === 'none') return '仅本机';
  return 'Cloudflare Quick Tunnel';
}

function tunnelSummary(configuration: BridgeConfigSnapshot | undefined): string {
  const tunnel = configuration?.tunnel;
  if (!tunnel || tunnel.provider === 'cloudflare') {
    return 'Cloudflare Quick Tunnel，重启后临时地址会变化';
  }
  if (tunnel.provider === 'cloudflare-named') {
    return tunnel.cloudflareNamedDomain
      ? `固定地址：${tunnel.cloudflareNamedDomain}`
      : 'Cloudflare Named Tunnel，等待填写固定主机名';
  }
  if (tunnel.provider === 'ngrok') {
    return tunnel.ngrokDomain
      ? `ngrok 固定地址：${tunnel.ngrokDomain}`
      : 'ngrok 开发域名，等待填写保留域名';
  }
  return '仅在本机暴露 MCP，不创建公网隧道';
}

function connectorAvailabilityLabel(status: BridgeStatus | undefined): string {
  if (status?.publicOrigin) return '公网隧道可用';
  if (status?.tunnelProvider === 'none') return '仅本机可用';
  return status?.state === 'running' ? '正在获取连接入口' : '未启动';
}

function StatusBadge({ status }: { status: BridgeStatus | undefined }) {
  const state = status?.state ?? 'stopped';
  return (
    <span className="dbb-status" data-state={state}>
      <span className="dbb-status-dot" />
      {stateLabel(state)}
    </span>
  );
}

interface DisclosureProps {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function Disclosure({
  title,
  summary,
  open,
  onToggle,
  children,
}: DisclosureProps) {
  return (
    <section className="dbb-disclosure" data-open={open}>
      <button
        className="dbb-disclosure-trigger"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="dbb-disclosure-title">{title}</span>
        <span className="dbb-disclosure-summary">{summary}</span>
        {open
          ? <ChevronUp className="dbb-disclosure-chevron" size={17} aria-hidden="true" />
          : <ChevronDown className="dbb-disclosure-chevron" size={17} aria-hidden="true" />}
      </button>
      {open && <div className="dbb-disclosure-content">{children}</div>}
    </section>
  );
}

interface ConnectionSettingsProps {
  configuration: BridgeConfigSnapshot | undefined;
  busy: string | undefined;
  onUpdate: (update: BridgeConfigUpdate) => void;
}

function ConnectionSettings({
  configuration,
  busy,
  onUpdate,
}: ConnectionSettingsProps) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<BridgeStatus['tunnelProvider']>('cloudflare');
  const [namedDomain, setNamedDomain] = useState('');
  const [namedToken, setNamedToken] = useState('');
  const [cloudflaredHttpProxy, setCloudflaredHttpProxy] = useState('');
  const [cloudflareEdgeAuthority, setCloudflareEdgeAuthority] = useState('');
  const [ngrokDomain, setNgrokDomain] = useState('');
  const [ngrokUseHttpProxy, setNgrokUseHttpProxy] = useState(false);
  const [allowSecretPathOnly, setAllowSecretPathOnly] = useState(false);
  const [newOrigin, setNewOrigin] = useState('');
  const configurationKey = configuration
    ? [
      configuration.tunnel.provider,
      configuration.tunnel.cloudflareNamedDomain,
      configuration.tunnel.cloudflareNamedTokenConfigured,
      configuration.tunnel.cloudflaredHttpProxy,
      configuration.tunnel.cloudflareEdgeAuthority,
      configuration.tunnel.ngrokDomain,
      configuration.tunnel.ngrokUseHttpProxy,
      configuration.allowSecretPathOnly,
    ].join('\0')
    : '';
  const appliedConfigurationKey = useRef('');
  const editable = configuration?.editable ?? false;
  const updating = busy === 'bridge.config.update';

  useEffect(() => {
    if (!configuration || configurationKey === appliedConfigurationKey.current) return;
    appliedConfigurationKey.current = configurationKey;
    setProvider(configuration.tunnel.provider);
    setNamedDomain(configuration.tunnel.cloudflareNamedDomain);
    setNamedToken('');
    setCloudflaredHttpProxy(configuration.tunnel.cloudflaredHttpProxy);
    setCloudflareEdgeAuthority(configuration.tunnel.cloudflareEdgeAuthority);
    setNgrokDomain(configuration.tunnel.ngrokDomain);
    setNgrokUseHttpProxy(configuration.tunnel.ngrokUseHttpProxy);
    setAllowSecretPathOnly(configuration.allowSecretPathOnly);
  }, [configuration, configurationKey]);

  const saveNamedTunnel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const tunnel: BridgeConfigUpdate['tunnel'] = {
      provider: 'cloudflare-named',
      cloudflareNamedDomain: namedDomain,
    };
    if (namedToken.trim()) tunnel.cloudflareNamedToken = namedToken.trim();
    onUpdate({ tunnel });
  };

  const saveNgrok = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onUpdate({
      tunnel: {
        provider: 'ngrok',
        ngrokDomain,
        ngrokUseHttpProxy,
      },
    });
  };

  const saveCloudflareProxy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const proxy = cloudflaredHttpProxy.trim();
    const edgeAuthority = cloudflareEdgeAuthority.trim();
    if (!proxy !== !edgeAuthority) return;

    onUpdate({
      tunnel: {
        cloudflaredHttpProxy: proxy,
        cloudflareEdgeAuthority: edgeAuthority,
      },
    });
  };

  const chooseQuickTunnel = () => {
    setProvider('cloudflare');
    onUpdate({ tunnel: { provider: 'cloudflare' } });
  };

  const saveSecretPathOnly = (checked: boolean) => {
    setAllowSecretPathOnly(checked);
    onUpdate({ allowSecretPathOnly: checked });
  };

  const chooseNamedTunnel = () => {
    setProvider('cloudflare-named');
  };

  const chooseLocalOnly = () => {
    setProvider('none');
    onUpdate({ tunnel: { provider: 'none' } });
  };

  const addAllowedOrigin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const origins = configuration?.allowedOrigins ?? [];
    onUpdate({ allowedOrigins: [...origins, newOrigin.trim()] });
    setNewOrigin('');
  };

  const removeAllowedOrigin = (origin: string) => {
    onUpdate({
      allowedOrigins: (configuration?.allowedOrigins ?? []).filter(item => item !== origin),
    });
  };

  return (
    <Disclosure
      title="连接设置"
      summary={tunnelSummary(configuration)}
      open={open}
      onToggle={() => { setOpen(value => !value); }}
    >
      <div className="dbb-tunnel-heading">
        <span>隧道模式</span>
        {!editable && <span>运行中时请先停止 Bridge</span>}
      </div>
      <div className="dbb-tunnel-options" role="radiogroup" aria-label="MCP 隧道模式">
        <button
          className="dbb-tunnel-option"
          data-selected={provider === 'cloudflare'}
          type="button"
          role="radio"
          aria-checked={provider === 'cloudflare'}
          disabled={!editable || updating}
          onClick={chooseQuickTunnel}
        >
          <span className="dbb-tunnel-option-icon" data-kind="quick">
            <Cloud size={18} aria-hidden="true" />
          </span>
          <span className="dbb-tunnel-option-content">
            <strong>Cloudflare Quick Tunnel（无需账号或域名）</strong>
            <span>零配置。每次启动会生成新地址，适合立即连接网页 Agent。</span>
            <span>需要本机已安装 cloudflared。</span>
          </span>
          <span className="dbb-mode-badge">公网 · 零配置</span>
        </button>
        <button
          className="dbb-tunnel-option"
          data-selected={provider === 'cloudflare-named'}
          type="button"
          role="radio"
          aria-checked={provider === 'cloudflare-named'}
          disabled={!editable || updating}
          onClick={chooseNamedTunnel}
        >
          <span className="dbb-tunnel-option-icon" data-kind="named">
            <LockKeyhole size={17} aria-hidden="true" />
          </span>
          <span className="dbb-tunnel-option-content">
            <strong>Cloudflare Named Tunnel</strong>
            <span>绑定 Cloudflare 管理的固定公网主机名，重启后 MCP 地址保持不变。</span>
            <span>需要 Cloudflare 账号、域名、Tunnel Token 和 Published application。</span>
          </span>
          <span className="dbb-mode-badge">固定地址</span>
        </button>
        <button
          className="dbb-tunnel-option"
          data-selected={provider === 'none'}
          type="button"
          role="radio"
          aria-checked={provider === 'none'}
          disabled={!editable || updating}
          onClick={chooseLocalOnly}
        >
          <span className="dbb-tunnel-option-icon" data-kind="local">
            <House size={17} aria-hidden="true" />
          </span>
          <span className="dbb-tunnel-option-content">
            <strong>仅本机</strong>
            <span>把 MCP 挂在 dsh 的本机 Web Server 上，适合内嵌浏览器里的 Connector。</span>
            <span>必须添加精确网页来源，不创建公网隧道。</span>
          </span>
          <span className="dbb-mode-badge">不公开</span>
        </button>
      </div>

      <div className="dbb-tunnel-form">
        <div className="dbb-form-label">
          <span>允许连接的网页来源</span>
        </div>
        <p className="dbb-form-hint">内置网页 Agent 来源已自动放行；自定义来源仍需精确填写。</p>
        {(configuration?.allowedOrigins ?? []).map(origin => {
          const isBuiltIn = BUILT_IN_ORIGINS.includes(origin);
          return (
            <div className="dbb-custom-row" key={origin}>
              <code className="dbb-custom-url">{origin}</code>
              <button
                className="dbb-icon-button"
                data-borderless="true"
                type="button"
                title={isBuiltIn ? `内置站点来源：${origin}` : `删除 ${origin}`}
                aria-label={isBuiltIn ? `内置站点来源 ${origin}` : `删除 ${origin}`}
                disabled={!editable || updating || isBuiltIn}
                onClick={() => { removeAllowedOrigin(origin); }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          );
        })}
        <form className="dbb-quick-form" onSubmit={addAllowedOrigin}>
          <input
            className="dbb-field"
            value={newOrigin}
            placeholder="https://example.com"
            aria-label="允许连接的网页来源"
            disabled={!editable || updating}
            required
            onChange={event => { setNewOrigin(event.currentTarget.value); }}
          />
          <button
            className="dbb-button"
            data-primary="true"
            type="submit"
            disabled={!editable || updating}
          >
            添加
          </button>
        </form>
      </div>

      {provider === 'cloudflare-named' && (
        <form className="dbb-tunnel-form" onSubmit={saveNamedTunnel}>
          <label className="dbb-form-label">
            <span>公网主机名</span>
            <input
              className="dbb-field"
              value={namedDomain}
              placeholder="mcp.example.com"
              aria-label="Cloudflare Named Tunnel 公网主机名"
              disabled={!editable || updating}
              required
              onChange={event => { setNamedDomain(event.currentTarget.value); }}
            />
          </label>
          <label className="dbb-form-label">
            <span>Tunnel Token</span>
            <input
              className="dbb-field"
              type="password"
              value={namedToken}
              placeholder={configuration?.tunnel.cloudflareNamedTokenConfigured
                ? '已保存；留空可沿用'
                : '粘贴 Cloudflare Tunnel Token'}
              aria-label="Cloudflare Named Tunnel Token"
              disabled={!editable || updating}
              autoComplete="off"
              onChange={event => { setNamedToken(event.currentTarget.value); }}
            />
          </label>
          <div className="dbb-tunnel-form-actions">
            <span className="dbb-form-hint">
              {configuration?.tunnel.provider === 'none'
                ? 'Token 仅保存到 Windows 凭据库。本机模式无需在 Cloudflare 配置 Service URL。'
                : `Token 仅保存到 Windows 凭据库。Cloudflare Service URL 必须填本机 Service URL：${configuration?.tunnel.localServiceUrl ?? '检测中'}`}
            </span>
            <button
              className="dbb-button"
              data-primary="true"
              type="submit"
              disabled={!editable || updating}
            >
              {updating ? <LoaderCircle className="dbb-spinner" size={15} /> : <Check size={15} />}
              保存固定隧道
            </button>
          </div>
        </form>
      )}

      <details className="dbb-advanced-settings">
        <summary>高级连接</summary>
        <form className="dbb-tunnel-form" onSubmit={saveCloudflareProxy}>
          <div className="dbb-form-label">
            <span>Cloudflare HTTP 代理（可选）</span>
          </div>
          <label className="dbb-form-label">
            <span>HTTP 代理地址</span>
            <input
              className="dbb-field"
              value={cloudflaredHttpProxy}
              placeholder="http://127.0.0.1:7897"
              aria-label="cloudflared HTTP 代理地址"
              disabled={!editable || updating}
              onChange={event => { setCloudflaredHttpProxy(event.currentTarget.value); }}
            />
          </label>
          <label className="dbb-form-label">
            <span>Cloudflare Edge 地址</span>
            <input
              className="dbb-field"
              value={cloudflareEdgeAuthority}
              placeholder="region1.v2.argotunnel.com:7844"
              aria-label="Cloudflare Edge 地址"
              disabled={!editable || updating}
              onChange={event => { setCloudflareEdgeAuthority(event.currentTarget.value); }}
            />
          </label>
          <p className="dbb-form-hint">
            开启 Clash / TUN 后 cloudflared 直连失败时使用。两项要同时填写；
            清空可恢复直连。Bridge 会在本机启动仅回环可用的 CONNECT 中继。
          </p>
          <div className="dbb-tunnel-form-actions">
            <button
              className="dbb-button"
              type="submit"
              disabled={!editable || updating || (
                !cloudflaredHttpProxy.trim() !== !cloudflareEdgeAuthority.trim()
              )}
            >
              保存 Cloudflare 代理
            </button>
          </div>
        </form>
        <form className="dbb-tunnel-form" onSubmit={saveNgrok}>
          <label className="dbb-checkbox-label">
            <input
              type="checkbox"
              checked={allowSecretPathOnly}
              disabled={!editable || updating}
              onChange={event => { saveSecretPathOnly(event.currentTarget.checked); }}
            />
            <span>允许无 Header 连接（仅凭秘密 URL）</span>
          </label>
          <label className="dbb-form-label">
            <span>ngrok 保留域名</span>
            <input
              className="dbb-field"
              value={ngrokDomain}
              placeholder="your-name.ngrok-free.dev"
              aria-label="ngrok 保留域名"
              disabled={!editable || updating}
              onChange={event => { setNgrokDomain(event.currentTarget.value); }}
            />
          </label>
          <label className="dbb-checkbox-label">
            <input
              type="checkbox"
              checked={ngrokUseHttpProxy}
              disabled={!editable || updating}
              onChange={event => { setNgrokUseHttpProxy(event.currentTarget.checked); }}
            />
            <span>让 ngrok 使用 HTTP 代理</span>
          </label>
          <div className="dbb-tunnel-form-actions">
            <button
              className="dbb-button"
              type="submit"
              disabled={!editable || updating || !ngrokDomain.trim()}
            >
              保存高级设置
            </button>
          </div>
        </form>
      </details>
    </Disclosure>
  );
}

interface QuickLinkButtonsProps {
  links: readonly QuickLink[];
  onOpen: (link: QuickLink) => void;
}

function QuickLinkButtons({ links, onOpen }: QuickLinkButtonsProps) {
  return (
    <div className="dbb-link-grid">
      {links.map(link => (
        <button
          className="dbb-link-button"
          key={link.id}
          type="button"
          onClick={() => { onOpen(link); }}
        >
          <span className="dbb-link-swatch" style={{ background: link.color }}>
            {link.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="dbb-link-label">{link.name}</span>
          <ExternalLink size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

interface DashboardProps {
  snapshot: BridgeControlSnapshot | undefined;
  busy: string | undefined;
  copied: boolean;
  getConnection: () => Promise<BridgeConnectionInfo>;
  customLinks: readonly QuickLink[];
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onCopy: () => void;
  onOpen: (link: QuickLink) => void;
  onAddLink: (name: string, url: string) => boolean;
  onDeleteLink: (id: string) => void;
  onUpdateConfig: (update: BridgeConfigUpdate) => void;
  onReturnToBrowser: () => void;
  onPairOAuth: () => Promise<OAuthPairingCode | undefined>;
  onRevokeOAuth: () => Promise<void>;
}

function Dashboard({
  snapshot,
  busy,
  copied,
  getConnection,
  customLinks,
  onStart,
  onStop,
  onReset,
  onCopy,
  onOpen,
  onAddLink,
  onDeleteLink,
  onUpdateConfig,
  onReturnToBrowser,
  onPairOAuth,
  onRevokeOAuth,
}: DashboardProps) {
  const [connection, setConnection] = useState<BridgeConnectionInfo | undefined>(undefined);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const [copyingConnection, setCopyingConnection] = useState<'url' | 'bearer' | undefined>(undefined);
  const [copiedConnection, setCopiedConnection] = useState<'url' | 'bearer' | undefined>(undefined);
  const [revealBearer, setRevealBearer] = useState(false);
  const [adding, setAdding] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [linkName, setLinkName] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [pairing, setPairing] = useState<OAuthPairingCode | undefined>(undefined);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [oauthError, setOauthError] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const status = snapshot?.bridge;
  const panes = snapshot?.browser.panes ?? [];
  const running = status?.state === 'running';
  const transitioning = status?.state === 'starting' || status?.state === 'stopping';

  useEffect(() => {
    if (!running) {
      setConnection(undefined);
      setConnectionError(undefined);
      setRevealBearer(false);
      setPairing(undefined);
      return;
    }
    let disposed = false;
    setConnectionError(undefined);
    getConnection().catch(fetchError => {
      if (!disposed) {
        setConnectionError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      }
    });
    return () => {
      disposed = true;
    };
  }, [getConnection, running]);

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);

  const copyConnectionValue = (field: 'url' | 'bearer') => {
    const value = field === 'url' ? connection?.mcpUrl : connection?.bearerToken;
    if (!value) return;
    void (async () => {
      setCopyingConnection(field);
      try {
        await copyText(value);
        setCopiedConnection(field);
        window.setTimeout(() => {
          setCopiedConnection(undefined);
        }, 2000);
      } finally {
        setCopyingConnection(undefined);
      }
    })();
  };

  const submitLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onAddLink(linkName, linkUrl)) return;
    setLinkName('');
    setLinkUrl('');
    setAdding(false);
  };

  const remaining = pairing ? Math.max(0, pairing.expiresAt - now) : 0;
  const pairingActive = pairing !== undefined && remaining > 0;
  const remainingLabel = `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`;

  const generatePairing = () => {
    void (async () => {
      setOauthError(undefined);
      try {
        const next = await onPairOAuth();
        if (next) {
          setPairing(next);
          setPairingCopied(false);
        }
      } catch (pairError) {
        setOauthError(pairError instanceof Error ? pairError.message : String(pairError));
      }
    })();
  };

  const copyPairing = () => {
    if (!pairingActive || !pairing) return;
    void (async () => {
      try {
        await copyText(pairing.code);
        setPairingCopied(true);
        window.setTimeout(() => { setPairingCopied(false); }, 1800);
      } catch (copyError) {
        setOauthError(copyError instanceof Error ? copyError.message : String(copyError));
      }
    })();
  };

  const revokeOAuth = () => {
    if (!window.confirm('撤销后已授权的网页 AI 需要重新授权。继续吗？')) return;
    void (async () => {
      setOauthError(undefined);
      try {
        await onRevokeOAuth();
        setPairing(undefined);
      } catch (revokeError) {
        setOauthError(revokeError instanceof Error ? revokeError.message : String(revokeError));
      }
    })();
  };

  return (
    <div className="dbb-dashboard">
      <div className="dbb-dashboard-inner">
        <header className="dbb-dashboard-header">
          <div>
            <h1 className="dbb-title">Browser Bridge</h1>
            <p className="dbb-subtitle">
              把当前 dsh 工作区作为受保护的 Streamable HTTP MCP 服务交给网页 AI，
              登录状态和文件读写都保留在这台机器上。
            </p>
          </div>
          <StatusBadge status={status} />
        </header>

        <div className="dbb-dashboard-actions">
          {running ? (
            <button
              className="dbb-button"
              type="button"
              disabled={busy !== undefined || transitioning}
              onClick={onStop}
            >
              <Power size={15} />
              停止 Bridge
            </button>
          ) : (
            <button
              className="dbb-button"
              data-primary="true"
              type="button"
              disabled={busy !== undefined || transitioning}
              onClick={onStart}
            >
              {busy === 'bridge.start'
                ? <LoaderCircle className="dbb-spinner" size={15} />
                : <Play size={15} />}
              启动 Bridge
            </button>
          )}
          <button
            className="dbb-button"
            type="button"
            disabled={!running || busy !== undefined}
            onClick={onCopy}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? '已复制' : '复制 MCP 提示词'}
          </button>
          <button
            className="dbb-button"
            type="button"
            disabled={busy !== undefined}
            onClick={onReset}
          >
            <RotateCw size={15} />
            重置 MCP 地址
          </button>
          {panes.length > 0 && (
            <button className="dbb-button" type="button" onClick={onReturnToBrowser}>
              <Globe2 size={15} />
              返回网页
            </button>
          )}
        </div>

        <section className="dbb-section" aria-label="快速打开">
          <div className="dbb-section-heading">
            <div>
              <h2 className="dbb-section-title">快速打开</h2>
              <p className="dbb-section-copy">在 dsh 会话区域打开网页，登录状态会持久保留。</p>
            </div>
          </div>
          <QuickLinkButtons links={BUILT_IN_LINKS} onOpen={onOpen} />
          <div className="dbb-section-heading dbb-custom-heading">
            <div>
              <h2 className="dbb-section-title">自己的站点</h2>
              <p className="dbb-section-copy">保存常用的 Agent 或支持 MCP 的网页入口。</p>
            </div>
            <button
              className="dbb-icon-button"
              type="button"
              title="添加网页入口"
              aria-label="添加网页入口"
              onClick={() => { setAdding(value => !value); }}
            >
              <Plus size={16} />
            </button>
          </div>
          {adding && (
            <form className="dbb-quick-form" onSubmit={submitLink}>
              <input
                className="dbb-field"
                value={linkName}
                placeholder="名称"
                aria-label="网页入口名称"
                required
                onChange={event => { setLinkName(event.currentTarget.value); }}
              />
              <input
                className="dbb-field"
                value={linkUrl}
                placeholder="https://example.com"
                aria-label="网页入口地址"
                required
                onChange={event => { setLinkUrl(event.currentTarget.value); }}
              />
              <button className="dbb-button" data-primary="true" type="submit">
                添加
              </button>
            </form>
          )}
          {customLinks.length > 0 && (
            <div className="dbb-custom-list">
              {customLinks.map(link => (
                <div className="dbb-custom-row" key={link.id}>
                  <button
                    className="dbb-command-link dbb-custom-name"
                    type="button"
                    onClick={() => { onOpen(link); }}
                  >
                    {link.name}
                  </button>
                  <span className="dbb-custom-url">{link.url}</span>
                  <button
                    className="dbb-icon-button"
                    data-borderless="true"
                    type="button"
                    title={`删除 ${link.name}`}
                    aria-label={`删除 ${link.name}`}
                    onClick={() => { onDeleteLink(link.id); }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <ConnectionSettings
          configuration={snapshot?.configuration}
          busy={busy}
          onUpdate={onUpdateConfig}
        />

        {running && (
          <section className="dbb-section" aria-label="Connector 配置">
            <div className="dbb-connector-heading">
              <div>
                <h2 className="dbb-section-title">Connector 配置</h2>
                <p className="dbb-section-copy">
                  粘贴到网页 AI 的自定义 MCP / Connector 设置；不要发到公开对话。
                </p>
              </div>
              <span className="dbb-mode-badge">{connectorAvailabilityLabel(status)}</span>
            </div>
            {connectionError && (
              <p className="dbb-field-error">{connectionError}</p>
            )}
            <div className="dbb-connector-grid">
              <label className="dbb-form-label">
                MCP URL
                <input
                  className="dbb-field"
                  readOnly
                  value={connection?.mcpUrl ?? ''}
                  placeholder="Bridge 连接信息不可用"
                />
              </label>
              <button
                className="dbb-button"
                type="button"
                disabled={!connection?.mcpUrl || copyingConnection !== undefined}
                onClick={() => { copyConnectionValue('url'); }}
              >
                {copiedConnection === 'url'
                  ? <Check size={15} />
                  : <Copy size={15} />}
                {copiedConnection === 'url' ? '已复制' : '复制 URL'}
              </button>
              <label className="dbb-form-label">
                Authorization
                <input
                  className="dbb-field"
                  readOnly
                  value={revealBearer
                    ? connection?.bearerToken ?? ''
                    : connection?.bearerToken ? 'Bearer ••••••••' : ''}
                  placeholder="不需要授权时为空"
                />
              </label>
              <div className="dbb-connector-actions">
                <button
                  className="dbb-icon-button"
                  type="button"
                  disabled={!connection?.bearerToken}
                  title={revealBearer ? '隐藏 Bearer Token' : '显示 Bearer Token'}
                  aria-label={revealBearer ? '隐藏 Bearer Token' : '显示 Bearer Token'}
                  onClick={() => { setRevealBearer(value => !value); }}
                >
                  {revealBearer ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button
                  className="dbb-button"
                  type="button"
                  disabled={!connection?.bearerToken || copyingConnection !== undefined}
                  onClick={() => { copyConnectionValue('bearer'); }}
                >
                  {copiedConnection === 'bearer'
                    ? <Check size={15} />
                    : <Copy size={15} />}
                  {copiedConnection === 'bearer' ? '已复制' : '复制 Token'}
                </button>
              </div>
            </div>
          </section>
        )}

        {running && (
          <section className="dbb-section" aria-label="OAuth 授权">
            <div className="dbb-connector-heading">
              <div>
                <h2 className="dbb-section-title">OAuth 授权</h2>
                <p className="dbb-section-copy">
                  生成配对码后，在网页 AI 打开的授权页输入，完成一次授权。
                </p>
              </div>
            </div>
            {oauthError && <p className="dbb-field-error">{oauthError}</p>}
            <div className="dbb-connector-grid">
              <label className="dbb-form-label">
                配对码
                <input
                  className="dbb-field"
                  readOnly
                  value={pairingActive && pairing ? pairing.code : ''}
                  placeholder={pairing ? '已过期，请重新生成' : '尚未生成'}
                />
              </label>
              <div className="dbb-connector-actions">
                <button className="dbb-button" type="button" onClick={generatePairing}>
                  <LockKeyhole size={15} />
                  生成配对码
                </button>
                <button
                  className="dbb-button"
                  type="button"
                  disabled={!pairingActive || pairingCopied}
                  onClick={copyPairing}
                >
                  {pairingCopied ? <Check size={15} /> : <Copy size={15} />}
                  {pairingCopied ? '已复制' : '复制配对码'}
                </button>
                <button className="dbb-button" type="button" onClick={revokeOAuth}>
                  <Trash2 size={15} />
                  撤销授权
                </button>
              </div>
            </div>
            {pairingActive && (
              <p className="dbb-section-copy">配对码有效期剩余 {remainingLabel}。</p>
            )}
          </section>
        )}

        <section className="dbb-section">
          <div className="dbb-section-heading">
            <div>
              <h2 className="dbb-section-title">连接状态</h2>
              <p className="dbb-section-copy">本机或公网健康检查通过后，Bridge 才会报告运行中。</p>
            </div>
          </div>
          <dl className="dbb-detail-grid">
            <div className="dbb-detail">
              <dt>隧道</dt>
              <dd>{tunnelLabel(status?.tunnelProvider ?? snapshot?.configuration.tunnel.provider)}</dd>
            </div>
            <div className="dbb-detail">
              <dt>连接入口</dt>
              <dd>{originLabel(status)}</dd>
            </div>
            <div className="dbb-detail">
              <dt>嵌入式浏览器</dt>
              <dd>
                {snapshot?.browser.available
                  ? '可用，登录会话已持久化'
                  : snapshot?.browser.reason ?? '正在检测 dsh Desktop'}
              </dd>
            </div>
            <div className="dbb-detail">
              <dt>浏览器标签</dt>
              <dd>{panes.length}</dd>
            </div>
          </dl>
          <p className="dbb-warning">
            <AlertTriangle size={15} />
            MCP 地址具备文件修改和命令执行能力，请勿公开；怀疑泄露时立即重置地址。
          </p>
        </section>
      </div>
    </div>
  );
}

function intersectRect(element: HTMLElement): BrowserBounds | undefined {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  let parent = element.parentElement;
  while (parent) {
    const style = window.getComputedStyle(parent);
    const clipsX = /(auto|scroll|hidden|clip)/u.test(style.overflowX);
    const clipsY = /(auto|scroll|hidden|clip)/u.test(style.overflowY);
    if (clipsX || clipsY) {
      const parentRect = parent.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, parentRect.left);
        right = Math.min(right, parentRect.right);
      }
      if (clipsY) {
        top = Math.max(top, parentRect.top);
        bottom = Math.min(bottom, parentRect.bottom);
      }
    }
    parent = parent.parentElement;
  }
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) return undefined;
  return { x: left, y: top, width, height };
}

function useBrowserBounds(
  workspaceId: string,
  visiblePaneIds: readonly string[],
  enabled: boolean,
): (paneId: string, element: HTMLDivElement | null) => void {
  const elements = useRef(new Map<string, HTMLDivElement>());
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const lastPayload = useRef('');
  const visibleKey = visiblePaneIds.join('\0');

  const sendBounds = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      if (!enabled || document.visibilityState === 'hidden') {
        lastPayload.current = '';
        void postAction({
          action: 'browser.hide',
          workspaceId,
        }).catch(() => undefined);
        return;
      }
      const panes = visiblePaneIds.flatMap((id) => {
        const element = elements.current.get(id);
        const bounds = element ? intersectRect(element) : undefined;
        return bounds ? [{ id, bounds }] : [];
      });
      const payload = JSON.stringify({ workspaceId, panes });
      if (payload === lastPayload.current) return;
      lastPayload.current = payload;
      void postAction({
        action: 'browser.bounds',
        workspaceId,
        panes,
      }).catch(() => undefined);
    });
  }, [enabled, visibleKey, workspaceId]);

  useLayoutEffect(() => {
    observer.current = new ResizeObserver(sendBounds);
    for (const element of elements.current.values()) observer.current.observe(element);
    window.addEventListener('resize', sendBounds);
    window.addEventListener('scroll', sendBounds, true);
    document.addEventListener('visibilitychange', sendBounds);
    sendBounds();
    return () => {
      observer.current?.disconnect();
      observer.current = undefined;
      window.removeEventListener('resize', sendBounds);
      window.removeEventListener('scroll', sendBounds, true);
      document.removeEventListener('visibilitychange', sendBounds);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      lastPayload.current = '';
      void postAction({
        action: 'browser.hide',
        workspaceId,
      }).catch(() => undefined);
    };
  }, [sendBounds, workspaceId]);

  useLayoutEffect(() => {
    sendBounds();
  }, [sendBounds, visibleKey]);

  return useCallback((paneId: string, element: HTMLDivElement | null) => {
    const previous = elements.current.get(paneId);
    if (previous && previous !== element) observer.current?.unobserve(previous);
    if (element) {
      elements.current.set(paneId, element);
      observer.current?.observe(element);
    } else {
      elements.current.delete(paneId);
    }
    sendBounds();
  }, [sendBounds]);
}

interface PaneChromeProps {
  pane: BrowserPaneSnapshot;
  nativeAvailable: boolean;
  nativeReason: string | undefined;
  registerSurface: (paneId: string, element: HTMLDivElement | null) => void;
  onActivate: () => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
}

function PaneChrome({
  pane,
  nativeAvailable,
  nativeReason,
  registerSurface,
  onActivate,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
}: PaneChromeProps) {
  const [address, setAddress] = useState(pane.url);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setAddress(pane.url);
  }, [pane.url]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    editing.current = false;
    onNavigate(address);
  };

  return (
    <section className="dbb-pane" onPointerDown={onActivate}>
      <form className="dbb-nav" onSubmit={submit}>
        <button
          className="dbb-icon-button"
          data-borderless="true"
          type="button"
          title="后退"
          aria-label="后退"
          disabled={!pane.canGoBack}
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className="dbb-icon-button"
          data-borderless="true"
          type="button"
          title="前进"
          aria-label="前进"
          disabled={!pane.canGoForward}
          onClick={onForward}
        >
          <ArrowRight size={16} />
        </button>
        <button
          className="dbb-icon-button"
          data-borderless="true"
          type="button"
          title={pane.loading ? '停止加载' : '重新加载'}
          aria-label={pane.loading ? '停止加载' : '重新加载'}
          onClick={pane.loading ? onStop : onReload}
        >
          {pane.loading ? <Square size={14} /> : <RotateCw size={15} />}
        </button>
        <input
          className="dbb-address"
          value={address}
          aria-label={`${pane.title || '网页'}地址`}
          spellCheck={false}
          onBlur={() => {
            editing.current = false;
            setAddress(pane.url);
          }}
          onChange={event => {
            editing.current = true;
            setAddress(event.currentTarget.value);
          }}
          onFocus={() => {
            editing.current = true;
          }}
        />
      </form>
      <div
        className="dbb-web-surface"
        ref={element => { registerSurface(pane.id, element); }}
      >
        {!nativeAvailable && (
          <div className="dbb-web-placeholder">
            <div className="dbb-web-placeholder-inner">
              <strong>嵌入式浏览器在 dsh Desktop 中可用</strong>
              <p>{nativeReason ?? '当前环境会改用系统浏览器打开网页。'}</p>
            </div>
          </div>
        )}
        {pane.error && (
          <div className="dbb-web-placeholder">
            <div className="dbb-web-placeholder-inner">
              <strong>网页加载失败</strong>
              <p>{pane.error}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

interface BrowserWorkspaceProps {
  snapshot: BridgeControlSnapshot;
  layout: LayoutMode;
  activePaneId: string;
  busy: string | undefined;
  copied: boolean;
  workspaceId: string;
  onDashboard: () => void;
  onNewPane: () => void;
  onLayout: (layout: LayoutMode) => void;
  onSelectPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onNavigate: (paneId: string, url: string) => void;
  onNavigation: (paneId: string, action: 'back' | 'forward' | 'reload' | 'stop') => void;
  onStart: () => void;
  onStop: () => void;
  onCopy: () => void;
}

function BrowserWorkspace({
  snapshot,
  layout,
  activePaneId,
  busy,
  copied,
  workspaceId,
  onDashboard,
  onNewPane,
  onLayout,
  onSelectPane,
  onClosePane,
  onNavigate,
  onNavigation,
  onStart,
  onStop,
  onCopy,
}: BrowserWorkspaceProps) {
  const panes = snapshot.browser.panes;
  const active = panes.find(pane => pane.id === activePaneId) ?? panes[0]!;
  const split = layout === 'split' && panes.length > 1;
  const visiblePanes = split ? panes.slice(0, 2) : [active];
  const visiblePaneIds = visiblePanes.map(pane => pane.id);
  const registerSurface = useBrowserBounds(
    workspaceId,
    visiblePaneIds,
    snapshot.browser.available,
  );
  const running = snapshot.bridge.state === 'running';

  return (
    <div className="dbb-browser">
      <div className="dbb-browser-header">
        <button
          className="dbb-icon-button"
          data-borderless="true"
          type="button"
          title="Bridge 设置"
          aria-label="Bridge 设置"
          onClick={onDashboard}
        >
          <Settings2 size={16} />
        </button>
        <div
          className="dbb-tabs"
          data-layout={split ? 'split' : 'single'}
          role="tablist"
          aria-label="浏览器标签页"
        >
          {panes.map(pane => (
            <div
              className="dbb-tab-shell"
              data-active={pane.id === active.id}
              key={pane.id}
              role="presentation"
            >
              <button
                className="dbb-tab"
                type="button"
                role="tab"
                aria-selected={pane.id === active.id}
                title={pane.title || pane.url}
                onClick={() => { onSelectPane(pane.id); }}
              >
                <Globe2 size={14} aria-hidden="true" />
                <span className="dbb-tab-title">{pane.title || pane.url}</span>
              </button>
              <button
                className="dbb-tab-close"
                type="button"
                title="关闭标签页"
                aria-label={`关闭 ${pane.title || pane.url}`}
                onClick={() => { onClosePane(pane.id); }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="dbb-browser-actions">
          <button
            className="dbb-icon-button"
            data-borderless="true"
            type="button"
            title="新建网页标签页"
            aria-label="新建网页标签页"
            onClick={onNewPane}
          >
            <Plus size={16} />
          </button>
          <span
            className="dbb-browser-status"
            data-state={snapshot.bridge.state}
            title={`Bridge ${stateLabel(snapshot.bridge.state)}`}
            aria-label={`Bridge ${stateLabel(snapshot.bridge.state)}`}
          />
          <button
            className="dbb-icon-button"
            data-borderless="true"
            type="button"
            title={running ? '停止 Bridge' : '启动 Bridge'}
            aria-label={running ? '停止 Bridge' : '启动 Bridge'}
            disabled={busy !== undefined}
            onClick={running ? onStop : onStart}
          >
            {running ? <Power size={15} /> : <Play size={15} />}
          </button>
          <button
            className="dbb-icon-button"
            data-borderless="true"
            type="button"
            title={copied ? 'MCP 提示词已复制' : '复制 MCP 提示词'}
            aria-label={copied ? 'MCP 提示词已复制' : '复制 MCP 提示词'}
            disabled={!running || busy !== undefined}
            onClick={onCopy}
          >
            {copied ? <Check size={15} /> : <Link2 size={15} />}
          </button>
          <div className="dbb-segments" aria-label="浏览器布局">
            <button
              className="dbb-segment"
              type="button"
              title="单窗口"
              aria-label="单窗口"
              aria-pressed={!split}
              onClick={() => { onLayout('single'); }}
            >
              <PanelTop size={15} />
            </button>
            <button
              className="dbb-segment"
              type="button"
              title="双窗口"
              aria-label="双窗口"
              aria-pressed={split}
              disabled={panes.length < 2}
              onClick={() => { onLayout('split'); }}
            >
              <Columns2 size={15} />
            </button>
          </div>
        </div>
      </div>

      <div className="dbb-pane-grid" data-layout={split ? 'split' : 'single'}>
        {visiblePanes.map(pane => (
          <PaneChrome
            key={pane.id}
            pane={pane}
            nativeAvailable={snapshot.browser.available}
            nativeReason={snapshot.browser.reason}
            registerSurface={registerSurface}
            onActivate={() => { onSelectPane(pane.id); }}
            onNavigate={url => { onNavigate(pane.id, url); }}
            onBack={() => { onNavigation(pane.id, 'back'); }}
            onForward={() => { onNavigation(pane.id, 'forward'); }}
            onReload={() => { onNavigation(pane.id, 'reload'); }}
            onStop={() => { onNavigation(pane.id, 'stop'); }}
          />
        ))}
      </div>
    </div>
  );
}

export function BrowserBridgeView({
  sessionId,
  useWorkspaces,
}: BrowserBridgeViewProps) {
  const workspaceId = useWorkspaces(snapshot => (
    snapshot.items.find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
      ?? `session:${sessionId}`
  ));
  const [snapshot, setSnapshot] = useState<BridgeControlSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [customLinks, setCustomLinks] = useState<QuickLink[]>(loadQuickLinks);
  const [layout, setLayout] = useState<LayoutMode>(initialLayout);
  const [activePaneId, setActivePaneId] = useState('pane-1');
  const [showDashboard, setShowDashboard] = useState(true);
  const copyTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchSnapshot(workspaceId, signal);
    setSnapshot(next);
    setError(undefined);
    return next;
  }, [workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const poll = async () => {
      try {
        await refresh(controller.signal);
      } catch (pollError) {
        if (!disposed && !(pollError instanceof DOMException && pollError.name === 'AbortError')) {
          setError(pollError instanceof Error ? pollError.message : String(pollError));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(QUICK_LINK_STORAGE, JSON.stringify(customLinks));
  }, [customLinks]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE, layout);
  }, [layout]);

  useEffect(() => () => {
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
  }, []);

  const panes = snapshot?.browser.panes ?? [];
  useEffect(() => {
    if (panes.length === 0) {
      setShowDashboard(true);
      return;
    }
    if (!panes.some(pane => pane.id === activePaneId)) {
      setActivePaneId(panes[0]!.id);
    }
    if (panes.length < 2 && layout === 'split') setLayout('single');
  }, [activePaneId, layout, panes]);

  const execute = useCallback(async <T,>(
    action: BridgeControlAction,
  ): Promise<T | undefined> => {
    setBusy(action.action);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await postAction<T>(action);
      try {
        await refresh();
      } catch (refreshError) {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
      return result;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  const startBridge = useCallback(() => {
    void (async () => {
      setBusy('bridge.start');
      setError(undefined);
      setNotice(undefined);
      try {
        await postActionWithTimeout<BridgeStatus>(
          { action: 'bridge.start', workspaceId },
          30_000,
        );
        await refresh();
      } catch (startError) {
        const message = startError instanceof DOMException && startError.name === 'AbortError'
          ? 'Bridge 启动超时，请查看连接状态和 DSH 日志。'
          : startError instanceof Error ? startError.message : String(startError);
        setError(message);
        try {
          await refresh();
        } catch {
          // Keep the original startup error visible when the follow-up snapshot fails.
        }
      } finally {
        setBusy(undefined);
      }
    })();
  }, [execute, workspaceId]);

  const stopBridge = useCallback(() => {
    void execute<BridgeStatus>({ action: 'bridge.stop', workspaceId });
  }, [execute, workspaceId]);

  const resetBridge = useCallback(() => {
    if (!window.confirm('重置后旧 MCP 地址会立即失效。继续吗？')) return;
    void execute<BridgeStatus>({ action: 'bridge.reset', workspaceId });
  }, [execute, workspaceId]);

  const updateBridgeConfig = useCallback((update: BridgeConfigUpdate) => {
    void execute<BridgeConfigSnapshot>({
      action: 'bridge.config.update',
      workspaceId,
      update,
    });
  }, [execute, workspaceId]);

  const pairOAuth = useCallback(() => (
    execute<OAuthPairingCode>({
      action: 'bridge.oauth.pair',
      workspaceId,
    })
  ), [execute, workspaceId]);

  const revokeOAuth = useCallback(async () => {
    await execute<BridgeStatus>({
      action: 'bridge.oauth.revoke',
      workspaceId,
    });
  }, [execute, workspaceId]);

  const copyConnection = useCallback(() => {
    void (async () => {
      setBusy('bridge.connection');
      setError(undefined);
      try {
        const info = await postAction<BridgeConnectionInfo>({
          action: 'bridge.connection',
          workspaceId,
        });
        await copyText(connectionPrompt(info));
        setCopied(true);
        setNotice('MCP 地址、授权信息和连接提示词已复制。');
        if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => {
          setCopied(false);
          setNotice(undefined);
        }, 2200);
      } catch (copyError) {
        setError(copyError instanceof Error ? copyError.message : String(copyError));
      } finally {
        setBusy(undefined);
      }
    })();
  }, [workspaceId]);

  const getConnection = useCallback(async () => {
    const info = await postAction<BridgeConnectionInfo>({
      action: 'bridge.connection',
      workspaceId,
    });
    return info;
  }, [workspaceId]);

  const openLink = useCallback((link: QuickLink) => {
    void (async () => {
      if (snapshot?.browser.available === false) {
        window.open(link.url, '_blank', 'noopener,noreferrer');
        setNotice(`已在系统浏览器打开 ${link.name}。`);
        return;
      }
      const used = new Set(panes.map(pane => pane.id));
      const paneId = createPaneId(panes);
      const opened = await execute<BrowserPaneSnapshot>({
        action: 'browser.open',
        workspaceId,
        paneId,
        url: link.url,
      });
      if (!opened) {
        setNotice(`嵌入式浏览器打开 ${link.name} 失败，请查看页面错误和控制日志。`);
        return;
      }
      setActivePaneId(paneId);
      setShowDashboard(false);
    })();
  }, [activePaneId, execute, panes, snapshot?.browser.available, workspaceId]);

  const newPane = useCallback(() => {
    openLink({ id: 'new', name: 'ChatGPT', url: DEFAULT_PAGE, color: '#2f8f79' });
  }, [openLink]);

  const closePane = useCallback((paneId: string) => {
    void execute<BridgeControlSnapshot>({
      action: 'browser.close',
      workspaceId,
      paneId,
    });
  }, [execute, workspaceId]);

  const navigate = useCallback((paneId: string, rawUrl: string) => {
    try {
      const url = normalizeWebUrl(rawUrl);
      void execute<BrowserPaneSnapshot>({
        action: 'browser.navigate',
        workspaceId,
        paneId,
        url,
      });
    } catch (urlError) {
      setError(urlError instanceof Error ? urlError.message : String(urlError));
    }
  }, [execute, workspaceId]);

  const navigateHistory = useCallback((
    paneId: string,
    action: 'back' | 'forward' | 'reload' | 'stop',
  ) => {
    void execute<BrowserPaneSnapshot>({
      action: `browser.${action}`,
      workspaceId,
      paneId,
    });
  }, [execute, workspaceId]);

  const addCustomLink = useCallback((linkName: string, rawUrl: string): boolean => {
    try {
      const nameValue = linkName.trim();
      if (!nameValue) throw new Error('请输入网页入口名称');
      const url = normalizeWebUrl(rawUrl);
      setCustomLinks(current => [...current, {
        id: createQuickLinkId(),
        name: nameValue,
        url,
        color: '#69717d',
      }]);
      return true;
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : String(linkError));
      return false;
    }
  }, []);

  const deleteCustomLink = useCallback((id: string) => {
    setCustomLinks(current => current.filter(link => link.id !== id));
  }, []);

  const updateLayout = useCallback((next: LayoutMode) => {
    if (next === 'split' && panes.length < 2) return;
    setLayout(next);
  }, [panes.length]);

  return (
    <div className="dbb-root" data-conversation-composer-overlay="">
      {error && (
        <div className="dbb-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button
            className="dbb-icon-button"
            data-borderless="true"
            type="button"
            title="关闭错误提示"
            aria-label="关闭错误提示"
            onClick={() => { setError(undefined); }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {notice && !error && (
        <div className="dbb-error" role="status">
          <Check size={15} />
          <span>{notice}</span>
          <button
            className="dbb-icon-button"
            data-borderless="true"
            type="button"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() => { setNotice(undefined); }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {showDashboard || !snapshot || panes.length === 0 ? (
        <Dashboard
          snapshot={snapshot}
          busy={busy}
          copied={copied}
          getConnection={getConnection}
          customLinks={customLinks}
          onStart={startBridge}
          onStop={stopBridge}
          onReset={resetBridge}
          onCopy={copyConnection}
          onOpen={openLink}
          onAddLink={addCustomLink}
          onDeleteLink={deleteCustomLink}
          onUpdateConfig={updateBridgeConfig}
          onReturnToBrowser={() => { setShowDashboard(false); }}
          onPairOAuth={pairOAuth}
          onRevokeOAuth={revokeOAuth}
        />
      ) : (
        <BrowserWorkspace
          snapshot={snapshot}
          layout={layout}
          activePaneId={activePaneId}
          busy={busy}
          copied={copied}
          workspaceId={workspaceId}
          onDashboard={() => { setShowDashboard(true); }}
          onNewPane={newPane}
          onLayout={updateLayout}
          onSelectPane={setActivePaneId}
          onClosePane={closePane}
          onNavigate={navigate}
          onNavigation={navigateHistory}
          onStart={startBridge}
          onStop={stopBridge}
          onCopy={copyConnection}
        />
      )}
    </div>
  );
}
