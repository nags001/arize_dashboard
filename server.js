const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const MODEL_ID = 'TW9kZWw6NjYxMDQ0NjIxNTpqZ1Yv';

const AGENT_FILTERS = {
  resort: { span: 'resort_exploration_agent', error: 'resort_exploration_agent' },
  ticket: { span: 'ticket_selector',          error: 'ticket_selector' },
  qa:     { span: 'trip_preferences_extractor', error: 'resort_qa' },
};

function p99(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)];
}

async function gql(apiKey, query) {
  const r = await fetch('https://app.arize.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

app.post('/api/arize/all', async (req, res) => {
  const { apiKey, days = 7 } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey is required.' });

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
      const spanRes = await gql(apiKey, `{ node(id: "${MODEL_ID}") { ... on Model { spanRecordsPublic(first: 25, dataset: { ${base}, queryFilter: "name LIKE '%${f.span}%'" }) { edges { node { latencyMs } } } } } }`);
      const errRes  = await gql(apiKey, `{ node(id: "${MODEL_ID}") { ... on Model { errors: spanRecordsPublic(first: 1, dataset: { ${base}, queryFilter: "name LIKE '%${f.error}%' AND status_code = 'ERROR'" }) { totalCount } } } }`);

      const latencies  = (spanRes.data?.node?.spanRecordsPublic?.edges || []).map(e => Math.round(e.node.latencyMs || 0));
      const errorCount = errRes.data?.node?.errors?.totalCount || 0;

      console.log(`[${key}] latencies=${JSON.stringify(latencies)} errorCount=${errorCount}`);
      agentData[key] = { latencies, errorCount };
    }

    const totalAgentLatency = Object.values(agentData).flatMap(v => v.latencies).reduce((s, v) => s + v, 0);
    console.log('totalAgentLatency:', totalAgentLatency);

    const agents = {};
    for (const [key, { latencies, errorCount }] of Object.entries(agentData)) {
      const latencyMs = latencies.reduce((s, v) => s + v, 0);
      const ratio     = totalAgentLatency > 0 ? latencyMs / totalAgentLatency : 0;
      console.log(`[${key}] latencyMs=${latencyMs} ratio=${ratio}`);

      agents[key] = {
        totalTokens:      Math.round(totalTokens * ratio),
        promptTokens:     Math.round(totalTokens * ratio * 0.96),
        completionTokens: Math.round(totalTokens * ratio * 0.04),
        cost:             parseFloat((totalCost * ratio).toFixed(4)),
        latencyMs,
        latencyRatio:     parseFloat((ratio * 100).toFixed(1)),
        latencyMsP99:     p99(latencies),
        errorCount,
      };
    }

    return res.json({ modelName: statsRes.data?.node?.name, agents });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('✅ Arize proxy running at http://localhost:3000'));
