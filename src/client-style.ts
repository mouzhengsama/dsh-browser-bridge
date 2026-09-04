export const CLIENT_STYLE_ID = 'dsh-browser-bridge-style';

export const CLIENT_STYLE = `
[data-conversation-scroll]:has(.dbb-root) > [data-composer-seat] {
  display: none !important;
}

.dbb-root,
.dbb-root * {
  box-sizing: border-box;
  letter-spacing: 0;
}

.dbb-root {
  --dbb-bg: var(--dsw-alias-bg-base, #17191d);
  --dbb-bg-raised: var(--dsw-alias-bg-layer-1, #1f2227);
  --dbb-bg-hover: var(--dsw-alias-interactive-bg-hover, #2a2e34);
  --dbb-border: var(--dsw-alias-divider-regular, #343940);
  --dbb-text: var(--dsw-alias-label-primary, #f3f4f6);
  --dbb-muted: var(--dsw-alias-label-secondary, #a2a8b2);
  --dbb-accent: var(--dsw-alias-state-business-primary, #26a6c8);
  --dbb-accent-text: #071b21;
  --dbb-success: #35b990;
  --dbb-warning: #e1ad43;
  --dbb-danger: #ef6d72;
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--dbb-text);
  background: var(--dbb-bg);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.dbb-button,
.dbb-icon-button,
.dbb-link-button,
.dbb-tab,
.dbb-tab-close,
.dbb-segment {
  color: inherit;
  font: inherit;
}

.dbb-button,
.dbb-icon-button,
.dbb-link-button,
.dbb-segment {
  border: 1px solid var(--dbb-border);
  border-radius: 6px;
  background: var(--dbb-bg-raised);
  cursor: pointer;
}

.dbb-button:hover:not(:disabled),
.dbb-icon-button:hover:not(:disabled),
.dbb-link-button:hover:not(:disabled),
.dbb-segment:hover:not(:disabled) {
  background: var(--dbb-bg-hover);
}

.dbb-button:focus-visible,
.dbb-icon-button:focus-visible,
.dbb-link-button:focus-visible,
.dbb-tab:focus-visible,
.dbb-tab-close:focus-visible,
.dbb-segment:focus-visible,
.dbb-address:focus-visible,
.dbb-field:focus-visible {
  outline: 2px solid var(--dbb-accent);
  outline-offset: 1px;
}

.dbb-button:disabled,
.dbb-icon-button:disabled,
.dbb-link-button:disabled,
.dbb-tab:disabled,
.dbb-tab-close:disabled,
.dbb-segment:disabled {
  cursor: default;
  opacity: 0.45;
}

.dbb-button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 5px 12px;
  white-space: nowrap;
}

.dbb-button[data-primary="true"] {
  border-color: transparent;
  color: var(--dbb-accent-text);
  background: var(--dbb-accent);
  font-weight: 600;
}

.dbb-button[data-primary="true"]:hover:not(:disabled) {
  filter: brightness(1.08);
  background: var(--dbb-accent);
}

.dbb-icon-button {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.dbb-icon-button[data-borderless="true"] {
  border-color: transparent;
  background: transparent;
}

.dbb-dashboard {
  min-height: 0;
  overflow: auto;
  padding: 18px 20px 24px;
}

.dbb-dashboard-inner {
  width: min(100%, 1040px);
  margin: 0 auto;
}

.dbb-dashboard-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--dbb-border);
}

.dbb-title {
  margin: 0;
  font-size: 19px;
  line-height: 1.3;
  font-weight: 650;
}

.dbb-subtitle {
  max-width: 720px;
  margin: 5px 0 0;
  color: var(--dbb-muted);
}

.dbb-status {
  display: inline-flex;
  min-height: 26px;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  padding: 3px 9px;
  border: 1px solid var(--dbb-border);
  border-radius: 999px;
  color: var(--dbb-muted);
  background: var(--dbb-bg-raised);
  white-space: nowrap;
}

.dbb-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dbb-muted);
}

.dbb-status[data-state="running"] .dbb-status-dot {
  background: var(--dbb-success);
}

.dbb-status[data-state="starting"] .dbb-status-dot,
.dbb-status[data-state="stopping"] .dbb-status-dot {
  background: var(--dbb-warning);
}

.dbb-status[data-state="failed"] .dbb-status-dot {
  background: var(--dbb-danger);
}

.dbb-dashboard-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 0 4px;
}

.dbb-section {
  padding: 18px 0;
  border-bottom: 1px solid var(--dbb-border);
}

.dbb-section:last-child {
  border-bottom: 0;
}

.dbb-connector-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.dbb-connector-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 10px;
}

.dbb-connector-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
}

.dbb-field-error {
  margin: 0 0 10px;
  color: var(--dbb-danger);
  font-size: 12px;
}

.dbb-disclosure {
  margin-top: 12px;
  border: 1px solid var(--dbb-border);
  border-radius: 6px;
  background: var(--dbb-bg-raised);
  overflow: hidden;
}

.dbb-disclosure-trigger {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 10px 13px;
  border: 0;
  color: var(--dbb-text);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dbb-disclosure-trigger:hover {
  background: var(--dbb-bg-hover);
}

.dbb-disclosure-trigger:focus-visible {
  outline: 2px solid var(--dbb-accent);
  outline-offset: -2px;
}

.dbb-disclosure-title {
  font-size: 15px;
  font-weight: 650;
}

.dbb-disclosure-summary {
  min-width: 0;
  overflow: hidden;
  color: var(--dbb-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dbb-disclosure-chevron {
  color: var(--dbb-muted);
}

.dbb-disclosure-content {
  padding: 14px;
  border-top: 1px solid var(--dbb-border);
}

.dbb-tunnel-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--dbb-text);
  font-size: 12px;
  font-weight: 650;
}

.dbb-tunnel-heading span + span {
  color: var(--dbb-warning);
  font-size: 11px;
  font-weight: 400;
}

.dbb-tunnel-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.dbb-tunnel-option {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dbb-border);
  border-radius: 6px;
  color: var(--dbb-text);
  background: var(--dbb-bg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dbb-tunnel-option:hover:not(:disabled) {
  background: var(--dbb-bg-hover);
}

.dbb-tunnel-option:focus-visible {
  outline: 2px solid var(--dbb-accent);
  outline-offset: 1px;
}

.dbb-tunnel-option[data-selected="true"] {
  border-color: color-mix(in srgb, var(--dbb-accent) 75%, var(--dbb-border));
  background: color-mix(in srgb, var(--dbb-accent) 11%, var(--dbb-bg));
}

.dbb-tunnel-option:disabled {
  cursor: default;
  opacity: 0.6;
}

.dbb-tunnel-option-icon {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: #ffffff;
}

.dbb-tunnel-option-icon[data-kind="quick"] {
  background: #267f9b;
}

.dbb-tunnel-option-icon[data-kind="named"] {
  background: #4d7a52;
}

.dbb-tunnel-option-content {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.dbb-tunnel-option-content strong {
  font-size: 13px;
  line-height: 1.35;
}

.dbb-tunnel-option-content span {
  color: var(--dbb-muted);
  font-size: 11px;
  line-height: 1.45;
}

.dbb-mode-badge {
  align-self: start;
  padding: 3px 7px;
  border-radius: 999px;
  color: #d9f2f8;
  background: #23677b;
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}

.dbb-tunnel-form {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.25fr);
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--dbb-border);
  border-radius: 6px;
  background: var(--dbb-bg);
}

.dbb-form-label {
  display: grid;
  min-width: 0;
  gap: 5px;
  color: var(--dbb-muted);
  font-size: 11px;
}

.dbb-tunnel-form-actions {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dbb-form-hint {
  min-width: 0;
  color: var(--dbb-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.dbb-advanced-settings {
  margin-top: 12px;
  border-top: 1px solid var(--dbb-border);
}

.dbb-advanced-settings > summary {
  padding: 10px 0 0;
  color: var(--dbb-muted);
  cursor: pointer;
  font-size: 12px;
}

.dbb-advanced-settings .dbb-tunnel-form {
  grid-template-columns: minmax(220px, 1fr) auto;
}

.dbb-checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dbb-muted);
  font-size: 12px;
}

.dbb-checkbox-label input {
  width: 15px;
  height: 15px;
  accent-color: var(--dbb-accent);
}

.dbb-custom-heading {
  margin-top: 16px;
}

.dbb-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.dbb-section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.dbb-section-copy {
  margin: 3px 0 0;
  color: var(--dbb-muted);
  font-size: 12px;
}

.dbb-link-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 8px;
}

.dbb-link-button {
  display: flex;
  min-width: 0;
  min-height: 38px;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  text-align: left;
}

.dbb-link-swatch {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 17px;
  line-height: 1;
  filter: saturate(1.2);
}

.dbb-link-label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dbb-custom-list {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}

.dbb-custom-row {
  display: grid;
  grid-template-columns: minmax(100px, 0.35fr) minmax(180px, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--dbb-border);
  border-radius: 6px;
  background: var(--dbb-bg-raised);
}

.dbb-custom-name,
.dbb-custom-url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dbb-custom-url {
  color: var(--dbb-muted);
}

.dbb-quick-form {
  display: grid;
  grid-template-columns: minmax(120px, 0.35fr) minmax(240px, 1fr) auto;
  gap: 8px;
  margin-top: 10px;
}

.dbb-field,
.dbb-address {
  min-width: 0;
  border: 1px solid var(--dbb-border);
  border-radius: 5px;
  color: var(--dbb-text);
  background: var(--dbb-bg);
  font: inherit;
}

.dbb-field {
  height: 34px;
  padding: 5px 9px;
}

.dbb-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px 18px;
}

.dbb-detail dt {
  color: var(--dbb-muted);
  font-size: 11px;
}

.dbb-detail dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}

.dbb-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 14px 0 0;
  color: var(--dbb-warning);
  font-size: 12px;
}

.dbb-error {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--dbb-danger) 55%, var(--dbb-border));
  color: #ffd7d9;
  background: color-mix(in srgb, var(--dbb-danger) 13%, var(--dbb-bg));
}

.dbb-error span {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}

.dbb-browser {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.dbb-browser-header {
  display: flex;
  min-width: 0;
  min-height: 39px;
  align-items: center;
  gap: 4px;
  padding: 3px 5px 0;
  border-bottom: 1px solid var(--dbb-border);
  background: var(--dbb-bg);
}

.dbb-browser-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  padding-bottom: 3px;
}

.dbb-browser-status {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  margin: 0 4px;
  border-radius: 50%;
  background: var(--dbb-muted);
}

.dbb-browser-status[data-state="running"] {
  background: var(--dbb-success);
}

.dbb-browser-status[data-state="starting"],
.dbb-browser-status[data-state="stopping"] {
  background: var(--dbb-warning);
}

.dbb-browser-status[data-state="failed"] {
  background: var(--dbb-danger);
}

.dbb-tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  align-self: stretch;
  align-items: end;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}

.dbb-tabs::-webkit-scrollbar {
  display: none;
}

.dbb-command-link {
  min-height: 28px;
  padding: 3px 9px;
  border: 0;
  border-radius: 5px;
  color: var(--dbb-muted);
  background: transparent;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.dbb-command-link:hover {
  color: var(--dbb-text);
  background: var(--dbb-bg-hover);
}

.dbb-command-spacer {
  flex: 1;
}

.dbb-segments {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 2px;
  border: 1px solid var(--dbb-border);
  border-radius: 6px;
  background: var(--dbb-bg-raised);
}

.dbb-segment {
  display: inline-flex;
  width: 28px;
  height: 24px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
}

.dbb-segment[aria-pressed="true"] {
  color: var(--dbb-text);
  background: var(--dbb-bg-hover);
}

.dbb-tab-shell {
  display: flex;
  min-width: 72px;
  max-width: 240px;
  height: 35px;
  flex: 0 1 240px;
  align-items: center;
  border: 1px solid var(--dbb-border);
  border-bottom-color: transparent;
  border-radius: 6px 6px 0 0;
  color: var(--dbb-muted);
  background: transparent;
}

.dbb-tab {
  display: flex;
  min-width: 0;
  height: 33px;
  flex: 1;
  align-items: center;
  gap: 7px;
  padding: 4px 3px 4px 9px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.dbb-tab-shell:hover {
  color: var(--dbb-text);
  background: var(--dbb-bg-hover);
}

.dbb-tab-shell[data-active="true"] {
  border-bottom-color: var(--dbb-bg-raised);
  color: var(--dbb-text);
  background: var(--dbb-bg-raised);
}

.dbb-tabs[data-layout="split"] .dbb-tab-shell {
  max-width: none;
  flex: 0 1 auto;
  min-width: 72px;
}

.dbb-tab-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dbb-tab-close {
  display: inline-flex;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.dbb-tab-close:hover {
  color: var(--dbb-text);
  background: var(--dbb-bg-hover);
}

.dbb-pane-grid {
  display: grid;
  flex: 1 1 0;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.dbb-pane-grid[data-layout="split"] {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.dbb-pane {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--dbb-bg-raised);
}

.dbb-pane + .dbb-pane {
  border-left: 1px solid var(--dbb-border);
}

.dbb-nav {
  display: flex;
  min-height: 38px;
  align-items: center;
  gap: 4px;
  padding: 4px 7px;
  border-bottom: 1px solid var(--dbb-border);
  background: var(--dbb-bg-raised);
}

.dbb-address {
  height: 29px;
  flex: 1;
  padding: 4px 9px;
}

.dbb-web-surface {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: #5f6873;
  background: #ffffff;
}

.dbb-web-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.dbb-web-placeholder-inner {
  max-width: 420px;
}

.dbb-web-placeholder strong {
  display: block;
  margin-bottom: 5px;
  color: #222831;
  font-size: 14px;
}

.dbb-web-placeholder p {
  margin: 0;
}

.dbb-spinner {
  animation: dbb-spin 1s linear infinite;
}

@keyframes dbb-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 760px) {
  .dbb-dashboard {
    padding: 14px 12px 20px;
  }

  .dbb-dashboard-header {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }

  .dbb-status {
    align-self: flex-start;
  }

  .dbb-custom-row,
  .dbb-quick-form {
    grid-template-columns: 1fr auto;
  }

  .dbb-disclosure-trigger {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .dbb-disclosure-summary {
    grid-column: 1;
    grid-row: 2;
    white-space: normal;
  }

  .dbb-disclosure-chevron {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .dbb-tunnel-options,
  .dbb-tunnel-form,
  .dbb-advanced-settings .dbb-tunnel-form {
    grid-template-columns: 1fr;
  }

  .dbb-tunnel-form-actions {
    grid-column: auto;
    align-items: stretch;
    flex-direction: column;
  }

  .dbb-tunnel-form-actions .dbb-button {
    width: 100%;
  }

  .dbb-custom-url,
  .dbb-quick-form .dbb-field:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .dbb-pane-grid[data-layout="split"] {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
`;
