import http from "http";
import https from "https";
import { URL } from "url";
import { EventEmitter } from "events";

export interface HealthRule {
  expectedStatus?: number[];
  bodyRegex?: string;
  maxLatencyMs?: number;
}

export interface EndpointConfig {
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  intervalMs: number;
  healthRules?: HealthRule;
  timeoutMs?: number;
  body?: string;
  enabled?: boolean;
}

export type CheckStatus = "healthy" | "degraded" | "unhealthy";

export interface CheckResult {
  endpointId: string;
  timestamp: number;
  statusCode: number | null;
  latencyMs: number;
  status: CheckStatus;
  violations: string[];
  error: string | null;
  body: string | null;
}

interface UptimeWindow {
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  availabilityPct: number;
}

export class MonitorEngine extends EventEmitter {
  private endpoints: Map<string, EndpointConfig> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private history: Map<string, CheckResult[]> = new Map();
  private maxHistoryPerEndpoint = 1000;

  addEndpoint(config: EndpointConfig): void {
    const existing = this.endpoints.get(config.id);
    if (existing) this.removeEndpoint(config.id);
    this.endpoints.set(config.id, config);
    this.history.set(config.id, []);
    if (config.enabled !== false) this.schedule(config.id);
    this.emit("endpoint:added", config);
  }

  removeEndpoint(id: string): void {
    this.stopTimer(id);
    this.endpoints.delete(id);
    this.history.delete(id);
    this.emit("endpoint:removed", id);
  }

  start(): void {
    for (const [id, cfg] of this.endpoints) {
      if (cfg.enabled !== false) this.schedule(id);
    }
    this.emit("engine:started");
  }

  stop(): void {
    for (const id of this.timers.keys()) this.stopTimer(id);
    this.emit("engine:stopped");
  }

  getEndpoint(id: string): EndpointConfig | undefined {
    return this.endpoints.get(id);
  }

  getAllEndpoints(): EndpointConfig[] {
    return [...this.endpoints.values()];
  }

  getHistory(id: string, limit?: number): CheckResult[] {
    const h = this.history.get(id) ?? [];
    return limit ? h.slice(-limit) : [...h];
  }

  getUptime(id: string, windowMs: number): UptimeWindow {
    const h = this.history.get(id) ?? [];
    const cutoff = Date.now() - windowMs;
    const recent = h.filter((r) => r.timestamp >= cutoff);
    const total = recent.length;
    const healthy = recent.filter((r) => r.status === "healthy").length;
    const degraded = recent.filter((r) => r.status === "degraded").length;
    const unhealthy = recent.filter((r) => r.status === "unhealthy").length;
    return {
      total,
      healthy,
      degraded,
      unhealthy,
      availabilityPct: total > 0 ? ((healthy + degraded) / total) * 100 : 100,
    };
  }

  async checkNow(id: string): Promise<CheckResult> {
    const cfg = this.endpoints.get(id);
    if (!cfg) throw new Error(`Unknown endpoint: ${id}`);
    const result = await this.performCheck(cfg);
    this.recordResult(result);
    return result;
  }

  private schedule(id: string): void {
    this.stopTimer(id);
    const cfg = this.endpoints.get(id);
    if (!cfg) return;
    const immediately = () => this.checkNow(id).catch(() => {});
    const loop = () => {
      this.checkNow(id).catch(() => {});
      this.timers.set(id, setTimeout(loop, cfg.intervalMs));
    };
    this.timers.set(id, setTimeout(loop, 0));
    void immediately;
  }

  private stopTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  private async performCheck(cfg: EndpointConfig): Promise<CheckResult> {
    const start = Date.now();
    const violations: string[] = [];
    let statusCode: number | null = null;
    let body: string | null = null;
    let error: string | null = null;

    try {
      const resp = await this.httpRequest(cfg);
      statusCode = resp.statusCode;
      body = resp.body;
    } catch (e: any) {
      error = e.message ?? String(e);
    }

    const latencyMs = Date.now() - start;
    const rules = cfg.healthRules ?? {};

    if (rules.expectedStatus && statusCode !== null) {
      if (!rules.expectedStatus.includes(statusCode)) {
        violations.push(`status ${statusCode} not in [${rules.expectedStatus.join(",")}]`);
      }
    }

    if (rules.bodyRegex && body !== null) {
      const re = new RegExp(rules.bodyRegex);
      if (!re.test(body)) {
        violations.push(`body did not match /${rules.bodyRegex}/`);
      }
    }

    if (rules.maxLatencyMs && latencyMs > rules.maxLatencyMs) {
      violations.push(`latency ${latencyMs}ms exceeds ${rules.maxLatencyMs}ms`);
    }

    if (error) violations.push(`request error: ${error}`);

    let status: CheckStatus = "healthy";
    if (violations.length > 0) {
      const hasCritical = violations.some(
        (v) => v.startsWith("status ") || v.startsWith("request error")
      );
      status = hasCritical ? "unhealthy" : "degraded";
    }

    return { endpointId: cfg.id, timestamp: start, statusCode, latencyMs, status, violations, error, body };
  }

  private httpRequest(cfg: EndpointConfig): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      let parsed: URL;
      try { parsed = new URL(cfg.url); } catch (e) { return reject(e); }

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;
      const method = (cfg.method ?? "GET").toUpperCase();
      const timeout = cfg.timeoutMs ?? 10000;

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: { "User-Agent": "api-watch/1.0", ...cfg.headers },
        timeout,
      };

      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      });

      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });

      if (cfg.body && method !== "GET" && method !== "HEAD") {
        req.write(cfg.body);
      }
      req.end();
    });
  }

  private recordResult(result: CheckResult): void {
    const h = this.history.get(result.endpointId);
    if (!h) return;
    h.push(result);
    if (h.length > this.maxHistoryPerEndpoint) h.splice(0, h.length - this.maxHistoryPerEndpoint);
    this.emit("check:complete", result);
    this.emit(`check:${result.endpointId}`, result);
  }
}

export default MonitorEngine;