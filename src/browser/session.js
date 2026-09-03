import fs from 'node:fs/promises';
import path from 'node:path';

export class BrowserSession {
  constructor({ artifactDir, runId, supervised = false, browserType = 'chromium' }) {
    this.artifactDir = artifactDir;
    this.runId = runId;
    this.supervised = supervised;
    this.browserType = browserType;
    this.browser = null;
    this.context = null;
    this._page = null;
    this.audit = [];
    this.screenshotIndex = 0;
  }

  async start() {
    if (this.browser) return this;
    let playwright;
    try { playwright = await import('playwright'); } catch (error) { throw new Error(`browser_unavailable: ${error.message}`); }
    const launcher = playwright[this.browserType];
    if (!launcher) throw new Error(`browser_type_unsupported: ${this.browserType}`);
    try {
      this.browser = await launcher.launch({ headless: !this.supervised });
      this.context = await this.browser.newContext();
      this._page = await this.context.newPage();
      if (this.supervised) await installOverlay(this._page);
      return this;
    } catch (error) {
      await this.close();
      throw new Error(`browser_start_failed: ${error.message}`);
    }
  }

  get page() {
    if (!this._page) throw new Error('browser_not_started');
    return this._page;
  }

  async goto(url) { return this.perform('goto', url, () => this.page.goto(url, { waitUntil: 'domcontentloaded' })); }
  async click(selector) { return this.perform('click', selector, () => this.page.locator(selector).click()); }
  async fill(selector, value) { return this.perform('fill', selector, () => this.page.locator(selector).fill(value), { sensitive: true }); }
  async text(selector) { return this.perform('text', selector, () => this.page.locator(selector).textContent()); }
  async title() { return this.perform('title', 'document', () => this.page.title()); }
  async screenshot(name = 'page') {
    const dir = path.join(this.artifactDir, this.runId, 'browser');
    await fs.mkdir(dir, { recursive: true });
    const index = String(++this.screenshotIndex).padStart(3, '0');
    const file = path.join(dir, `${index}-${safeFileName(name)}.png`);
    await this.page.screenshot({ path: file, fullPage: true });
    return file;
  }
  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this._page = null;
  }
  async perform(operation, target, action, options = {}) {
    const started = Date.now();
    const entry = { operation, target: options.sensitive ? '[SENSITIVE]' : String(target), status: 'passed', expected: options.expected || undefined };
    try {
      const value = await action();
      entry.actual = options.actual || 'completed';
      return value;
    } catch (error) {
      entry.status = 'failed';
      entry.actual = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.durationMs = Date.now() - started;
      this.audit.push(entry);
    }
  }
}

export async function installOverlay(page) {
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      if (document.getElementById('__agent_soak_supervision__')) return;
      const panel = document.createElement('div');
      panel.id = '__agent_soak_supervision__';
      panel.textContent = 'agent-soak supervision';
      Object.assign(panel.style, { position: 'fixed', zIndex: '2147483647', right: '12px', top: '12px', padding: '6px 9px', border: '1px solid #f59e0b', borderRadius: '4px', background: '#fff7ed', color: '#92400e', font: '12px system-ui' });
      document.body.appendChild(panel);
    });
  });
  await page.evaluate(() => {
    if (!document.getElementById('__agent_soak_supervision__')) {
      const panel = document.createElement('div'); panel.id = '__agent_soak_supervision__'; panel.textContent = 'agent-soak supervision';
      Object.assign(panel.style, { position: 'fixed', zIndex: '2147483647', right: '12px', top: '12px', padding: '6px 9px', border: '1px solid #f59e0b', borderRadius: '4px', background: '#fff7ed', color: '#92400e', font: '12px system-ui' }); document.body.appendChild(panel);
    }
  }).catch(() => {});
}

function safeFileName(value) { return String(value).replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 100) || 'page'; }
