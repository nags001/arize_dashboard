const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/config', (_req, res) => res.json({ apiKey: process.env.ARIZE_API_KEY || '' }));

const MODEL_IDS = {
  dev:   'TW9kZWw6NjYxMDQ0NjIxNTpqZ1Yv',
  stage: 'TW9kZWw6NjY3OTkyNDIyNTpoZFdv',
};

const AGENT_FILTERS = {
  resort: {
    span: 'resort_exploration_agent',
    error: 'resort_exploration_agent',
    subErrors: [
      'trip_preferences_extractor',
      'resort_preferences_extractor',
      'resort_match_summarizer',
    ],
  },
  ticket: { span: 'ticket_selector', error: 'ticket_selector' },
  qa:     { span: 'trip_preferences_extractor', error: 'resort_qa' },
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
function p99(values) { return percentile(values, 0.99); }
function p95(values) { return percentile(values, 0.95); }

async function gql(apiKey, query) {
  const r = await fetch('https://app.arize.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

app.post('/api/arize/all', async (req, res) => {
  const { apiKey, days = 7, env = 'dev' } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey is required.' });

  const MODEL_ID = MODEL_IDS[env] || MODEL_IDS.dev;
  const endTime   = new Date().toISOString();
  const startTime = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const base      = `startTime: "${startTime}", endTime: "${endTime}", environmentName: tracing, externalModelVersionIds: [], externalBatchIds: []`;

  try {
    const statsRes = await gql(apiKey, `{ node(id: "${MODEL_ID}") { ... on Model { name llmTracingStats(dataset: { ${base} }, timeZone: "UTC") { tokenCountTotal costTotal } } } }`);
    if (statsRes.errors) return res.status(400).json({ error: statsRes.errors[0]?.message });

    const stats       = statsRes.data?.node?.llmTracingStats;
    const totalCost   = stats?.costTotal || 0;
    const totalTokens = Math.round(stats?.tokenCountTotal || 0);

    const agentData = {};
    for (const [key, f] of Object.entries(AGENT_FILTERS)) {
      const [spanRes, errRes] = await Promise.all([
        gql(apiKey, `{ node(id: "${MODEL_ID}") { ... on Model { spanRecordsPublic(first: 50, dataset: { ${base}, queryFilter: "name LIKE '%${f.span}%'" }) { edges { node { latencyMs startTime } } } } } }`),
        gql(apiKey, `{ node(id: "${MODEL_ID}") { ... on Model { errors: spanRecordsPublic(first: 1, dataset: { ${base}, queryFilter: "name LIKE '%${f.error}%' AND status_code = 'ERROR'" }) { totalCount } } } }`),
      ]);

      const rawSpans = (spanRes.data?.node?.spanRecordsPublic?.edges || []).map(e => ({
        latencyMs: Math.round(e.node.latencyMs || 0),
        date: e.node.startTime ? e.node.startTime.slice(0, 10) : null,
      }));
      const latencies  = rawSpans.map(s => s.latencyMs);
      const errorCount = errRes.data?.node?.errors?.totalCount || 0;

      const dayBuckets = {};
      const bucketStart = new Date(Date.now() - days * 86400 * 1000);
      bucketStart.setUTCHours(0, 0, 0, 0);
      const bucketEnd = new Date();
      bucketEnd.setUTCHours(0, 0, 0, 0);
      for (let d = new Date(bucketStart); d <= bucketEnd; d = new Date(d.getTime() + 86400 * 1000)) {
        dayBuckets[d.toISOString().slice(0, 10)] = [];
      }
      for (const { latencyMs, date } of rawSpans) {
        if (date && date in dayBuckets) dayBuckets[date].push(latencyMs);
      }
      const latencyTimeSeries = Object.entries(dayBuckets).map(([date, vals]) => ({
        date,
        p99: vals.length ? p99(vals) : null,
        p95: vals.length ? p95(vals) : null,
      }));

      // Fetch sub-component errors if defined
      const subErrors = {};
      if (f.subErrors) {
        await Promise.all(f.subErrors.map(async (sub) => {
          const subRes = await gql(apiKey, `{ node(id: "${MODEL_ID}") { ... on Model { errors: spanRecordsPublic(first: 1, dataset: { ${base}, queryFilter: "name LIKE '%${sub}%' AND status_code = 'ERROR'" }) { totalCount } } } }`);
          subErrors[sub] = subRes.data?.node?.errors?.totalCount || 0;
        }));
      }

      agentData[key] = { latencies, latencyTimeSeries, errorCount, subErrors };
    }

    const totalAgentLatency = Object.values(agentData).flatMap(v => v.latencies).reduce((s, v) => s + v, 0);

    const agents = {};
    for (const [key, { latencies, latencyTimeSeries, errorCount, subErrors }] of Object.entries(agentData)) {
      const latencyMs = latencies.reduce((s, v) => s + v, 0);
      const ratio     = totalAgentLatency > 0 ? latencyMs / totalAgentLatency : 0;

      agents[key] = {
        totalTokens:      Math.round(totalTokens * ratio),
        promptTokens:     Math.round(totalTokens * ratio * 0.96),
        completionTokens: Math.round(totalTokens * ratio * 0.04),
        cost:             parseFloat((totalCost * ratio).toFixed(4)),
        latencyMs,
        latencyRatio:     parseFloat((ratio * 100).toFixed(1)),
        latencyMsP99:     p99(latencies),
        latencyTimeSeries,
        errorCount,
        subErrors,
      };
    }

    return res.json({ modelName: statsRes.data?.node?.name, agents });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('✅ Arize proxy running at http://localhost:3000'));
