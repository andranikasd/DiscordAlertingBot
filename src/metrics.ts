/** In-memory Prometheus-compatible counters. Values reset on process restart. */

const counters = {
  alerts_received_total: 0,
  alerts_sent_total: 0,
  dedup_suppressed_total: 0,
  no_config_suppressed_total: 0,
  discord_errors_total: 0,
  sqs_messages_processed_total: 0,
  discord_rate_limits_total: 0,
} as const satisfies Record<string, number>;

type CounterName = keyof typeof counters;

const state: Record<CounterName, number> = { ...counters };

export function inc(name: CounterName): void {
  state[name]++;
}

/** Serialize all counters in Prometheus text exposition format. */
export function metricsText(): string {
  const lines: string[] = [];
  for (const name of Object.keys(state) as CounterName[]) {
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${state[name]}`);
  }
  return lines.join("\n") + "\n";
}