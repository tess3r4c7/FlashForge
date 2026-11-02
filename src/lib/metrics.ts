import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

// ─── Prometheus metrics ─────────────────────────────────────────────────────
//
// Metrics are counters/histograms/gauges that are INCREMENTED in hot paths
// and SCRAPED periodically by a Prometheus server (or read via GET /metrics).
//
// Three rules keep this cheap:
//   1. Metrics are created ONCE at module load, not per request.
//   2. Labels are bounded: {method, route, status_code}, never {userId}.
//   3. Histograms use prom-client's default bucket scheme (good for latency).
//
// This file exports the registry and pre-defined metrics. Route handlers and
// workers import and increment them. The /metrics endpoint just serialises
// the registry (one call, ~1 ms).

export const registry = new Registry();

// Node.js internals: event loop lag, GC pauses, heap, open handles, etc.
// These tell us when the process is UNHEALTHY before user-facing latency spikes.
collectDefaultMetrics({ register: registry });

// ─── HTTP metrics ────────────────────────────────────────────────────────────

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests received",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

// ─── Business metrics ────────────────────────────────────────────────────────

export const ordersCreatedTotal = new Counter({
  name: "orders_created_total",
  help: "Total orders created (before payment)",
  registers: [registry],
});

export const paymentsProcessedTotal = new Counter({
  name: "payments_processed_total",
  help: "Total payments processed by the worker",
  labelNames: ["outcome"] as const, // CONFIRMED, CANCELLED, SKIPPED
  registers: [registry],
});

export const outboxPublishedTotal = new Counter({
  name: "outbox_published_total",
  help: "Total events published by the outbox relay",
  registers: [registry],
});

export const outboxPendingGauge = new Gauge({
  name: "outbox_pending_count",
  help: "Number of unpublished outbox events",
  registers: [registry],
});

export const rateLimitHitsTotal = new Counter({
  name: "rate_limit_hits_total",
  help: "Total requests rejected by the rate limiter",
  labelNames: ["bucket"] as const,
  registers: [registry],
});

export const cacheHitsTotal = new Counter({
  name: "cache_hits_total",
  help: "Redis cache hits",
  labelNames: ["key_prefix"] as const,
  registers: [registry],
});

export const cacheMissesTotal = new Counter({
  name: "cache_misses_total",
  help: "Redis cache misses (fell through to DB)",
  labelNames: ["key_prefix"] as const,
  registers: [registry],
});

