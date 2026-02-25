const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const GAMMA_BASE_URL = process.env.GAMMA_BASE_URL || 'https://gamma-api.polymarket.com';

function extractSlugFromUrl(input) {
  try {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);
    const eventIndex = parts.indexOf('event');
    if (eventIndex !== -1 && parts[eventIndex + 1]) {
      return parts[eventIndex + 1];
    }
    // For sports and other sections, fall back to the last path segment,
    // e.g. /sports/dota-2/dota2-lix0es-lynx-2026-02-25
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
    return null;
  } catch {
    return null;
  }
}

function buildEventsUrlFromInput(rawInput) {
  const input = rawInput.trim();

  const slugFromUrl = extractSlugFromUrl(input);
  const slug = slugFromUrl || input;

  const params = new URLSearchParams({
    slug,
    active: 'true',
    closed: 'false',
    limit: '1',
  });

  return `${GAMMA_BASE_URL}/events?${params.toString()}`;
}

async function resolveEventFromInput(rawInput) {
  const input = rawInput.trim();
  const slugFromUrl = extractSlugFromUrl(input);

  // 1) Try direct events lookup by slug (works for most non-sports markets).
  if (slugFromUrl) {
    const params = new URLSearchParams({
      slug: slugFromUrl,
      active: 'true',
      closed: 'false',
      limit: '1',
    });
    const directUrl = `${GAMMA_BASE_URL}/events?${params.toString()}`;
    const directResp = await axios.get(directUrl);
    if (Array.isArray(directResp.data) && directResp.data.length > 0) {
      return directResp.data[0];
    }
  }

  // 2) Fallback: use public-search so we can handle sports URLs, series pages,
  // and other slugs that don't map 1:1 to /events.
  const searchQuery = slugFromUrl || input;
  const searchResp = await axios.get(`${GAMMA_BASE_URL}/public-search`, {
    params: {
      q: searchQuery,
      limit_per_type: 5,
      cache: true,
    },
  });

  const events = searchResp.data && Array.isArray(searchResp.data.events)
    ? searchResp.data.events
    : [];

  if (!events.length) {
    return null;
  }

  // Prefer events that are active and whose slug includes the slugFromUrl hint, if present.
  if (slugFromUrl) {
    const normalized = slugFromUrl.toLowerCase();
    const filtered = events.filter(
      (e) =>
        e &&
        typeof e.slug === 'string' &&
        e.slug.toLowerCase().includes(normalized),
    );
    if (filtered.length) {
      return filtered[0];
    }
  }

  // Otherwise just take the first event result.
  return events[0];
}

function buildMarketsUrlFromInput(rawInput) {
  const input = rawInput.trim();

  const slugFromUrl = extractSlugFromUrl(input);
  if (slugFromUrl) {
    const params = new URLSearchParams({
      slug: slugFromUrl,
      active: 'true',
      closed: 'false',
      limit: '1',
    });
    return `${GAMMA_BASE_URL}/markets?${params.toString()}`;
  }

  if (/^0x[a-fA-F0-9]{64}$/.test(input)) {
    const params = new URLSearchParams({
      condition_ids: input,
      active: 'true',
      closed: 'false',
      limit: '1',
    });
    return `${GAMMA_BASE_URL}/markets?${params.toString()}`;
  }

  if (/^[0-9]+$/.test(input)) {
    const params = new URLSearchParams({
      id: input,
      active: 'true',
      closed: 'false',
      limit: '1',
    });
    return `${GAMMA_BASE_URL}/markets?${params.toString()}`;
  }

  const params = new URLSearchParams({
    slug: input,
    active: 'true',
    closed: 'false',
    limit: '1',
  });
  return `${GAMMA_BASE_URL}/markets?${params.toString()}`;
}

function parseMarketSnapshot(market) {
  let outcomes;
  let outcomePrices;
  let clobTokenIds;

  try {
    outcomes = market.outcomes ? JSON.parse(market.outcomes) : [];
  } catch {
    outcomes = [];
  }

  try {
    outcomePrices = market.outcomePrices
      ? JSON.parse(market.outcomePrices).map((p) => parseFloat(p))
      : [];
  } catch {
    outcomePrices = [];
  }

  try {
    clobTokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
  } catch {
    clobTokenIds = [];
  }

  // Determine primary and secondary outcome indices.
  // Prefer explicit "Yes"/"No" labels, but fall back to the first two outcomes
  // so this also works for "Up/Down" markets and team vs team markets.
  let yesIndex =
    outcomes.findIndex(
      (o) => typeof o === 'string' && o.toLowerCase() === 'yes',
    ) ?? -1;
  let noIndex =
    outcomes.findIndex(
      (o) => typeof o === 'string' && o.toLowerCase() === 'no',
    ) ?? -1;

  if (yesIndex === -1 || noIndex === -1) {
    if (Array.isArray(outcomes) && outcomes.length >= 2) {
      yesIndex = 0;
      noIndex = 1;
    }
  }

  const yesPrice =
    yesIndex >= 0 && outcomePrices[yesIndex] != null
      ? outcomePrices[yesIndex]
      : null;
  const noPrice =
    noIndex >= 0 && outcomePrices[noIndex] != null
      ? outcomePrices[noIndex]
      : yesPrice != null
      ? 1 - yesPrice
      : null;

  const yesAssetId =
    yesIndex >= 0 && clobTokenIds[yesIndex] ? clobTokenIds[yesIndex] : null;
  const noAssetId =
    noIndex >= 0 && clobTokenIds[noIndex] ? clobTokenIds[noIndex] : null;

  return {
    marketId: market.id,
    slug: market.slug,
    conditionId: market.conditionId,
    question: market.question,
    outcomes,
    yesPrice,
    noPrice,
    yesLabel: yesIndex >= 0 ? outcomes[yesIndex] : 'Yes',
    noLabel: noIndex >= 0 ? outcomes[noIndex] : 'No',
    yesAssetId,
    noAssetId,
  };
}

function parseEventMarkets(event) {
  if (!event || !Array.isArray(event.markets)) {
    return [];
  }

  return event.markets.map((m) => {
    const snapshot = parseMarketSnapshot(m);
    return {
      label: m.groupItemTitle || m.question || m.slug,
      ...snapshot,
    };
  });
}

app.get('/api/event', async (req, res) => {
  const { input } = req.query;

  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'Missing input parameter' });
  }

  try {
    const event = await resolveEventFromInput(input);
    if (!event) {
      return res.status(404).json({ error: 'No event found for input' });
    }
    const markets = parseEventMarkets(event).filter(
      (m) =>
        m.yesAssetId &&
        m.noAssetId &&
        (m.yesPrice != null || m.noPrice != null),
    );

    if (!markets.length) {
      return res
        .status(404)
        .json({ error: 'No tradable markets found for event' });
    }

    return res.json({
      eventId: event.id,
      slug: event.slug,
      title: event.title,
      markets,
    });
  } catch (err) {
    console.error('Error fetching event', err.message || err);
    return res.status(500).json({ error: 'Failed to fetch event data' });
  }
});

app.get('/api/market', async (req, res) => {
  const { input } = req.query;

  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'Missing input parameter' });
  }

  try {
    const url = buildMarketsUrlFromInput(input);
    const response = await axios.get(url);

    if (!Array.isArray(response.data) || response.data.length === 0) {
      return res.status(404).json({ error: 'No market found for input' });
    }

    const market = response.data[0];
    const snapshot = parseMarketSnapshot(market);

    if (!snapshot.yesAssetId || !snapshot.noAssetId) {
      return res.status(500).json({
        error: 'Market does not expose clob token IDs for streaming',
      });
    }

    return res.json(snapshot);
  } catch (err) {
    console.error('Error fetching market', err.message || err);
    return res.status(500).json({ error: 'Failed to fetch market data' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});

