import { UnavailableState } from '@/components/UnavailableState';

export default function ObservabilityPage() {
  return (
    <UnavailableState
      title="Observability"
      description="API health, Dhan bridge, market-data pipeline, Redis, PostgreSQL, pgvector."
      reason="A dedicated observability API (bridge/pipeline/datastore probes) is not yet exposed. Overlapping live data — API health, route latency and request timeseries — is already available on the Users / System page and the Dashboard."
      sections={[
        { label: 'System metrics', hint: 'Requests, errors, response time, throughput', span: 2 },
        { label: 'Top endpoints', hint: 'Busiest routes by volume', span: 1 },
        { label: 'Error rate by service', hint: 'Per-service error share', span: 1 },
        { label: 'Bridge & datastore health', hint: 'Dhan bridge, Redis, PostgreSQL, pgvector', span: 2 },
      ]}
    />
  );
}
