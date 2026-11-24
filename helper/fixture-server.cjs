'use strict';

/**
 * Dev-only fixture server for screenshots and UI states.
 * Never part of production injection; responses are labelled fixture:true.
 */

const { createServer } = require('./server.cjs');

const MODELS = [
  { id: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen', family: 'Gemini', poolKey: 'gemini', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), recommended: true, supportsThinking: true, maxTokens: 1048576 },
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon', family: 'Gemini', poolKey: 'gemini', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), recommended: true, supportsThinking: true, maxTokens: 1048576 },
  { id: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon', family: 'Gemini', poolKey: 'gemini', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), recommended: true, supportsThinking: true, maxTokens: 1048576 },
  { id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon', family: 'Gemini', poolKey: 'gemini', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), recommended: true, supportsThinking: true, maxTokens: 1048576 },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', family: 'Gemini', poolKey: 'gemini', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), recommended: true, supportsThinking: true, maxTokens: 1048576 },
  { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5', family: 'Claude', poolKey: '3p', remainingPct: 18, usedPct: 82, resetsAt: new Date(Date.now() + 42 * 60_000).toISOString(), recommended: true, supportsThinking: true, maxTokens: 200000 },
  { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5', family: 'Claude', poolKey: '3p', remainingPct: 18, usedPct: 82, resetsAt: new Date(Date.now() + 42 * 60_000).toISOString(), recommended: true, supportsThinking: true, maxTokens: 200000 },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', family: 'GPT', poolKey: '3p', remainingPct: 18, usedPct: 82, resetsAt: new Date(Date.now() + 42 * 60_000).toISOString(), recommended: false, supportsThinking: true, maxTokens: 131072 },
];

const SCENARIOS = {
  healthy: {
    ok: true,
    checkedAt: new Date().toISOString(),
    source: 'antigravity',
    fixture: true,
    accounts: [
      {
        label: 'demo@example.com',
        plan: 'Google AI Pro',
        tierId: 'g1-pro-tier',
        email: 'demo@example.com',
        credits: [{ type: 'GOOGLE_ONE_AI', minAmount: '50' }],
        windows: [
          { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
          { id: 'gemini-weekly', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · Weekly', remainingPct: 91.2, usedPct: 8.8, resetsAt: new Date(Date.now() + 5.4 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
          { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 18, usedPct: 82, resetsAt: new Date(Date.now() + 42 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
          { id: '3p-weekly', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · Weekly', remainingPct: 49.6, usedPct: 50.4, resetsAt: new Date(Date.now() + 4.8 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
        ],
        pools: [
          {
            key: 'gemini',
            title: 'Gemini',
            models: ['Gemini 4 Hydrogen', 'Gemini 4 Argon', 'Gemini 4 Carbon', 'Gemini 4 Neon', 'Gemini 3.8 Flash'],
            windows: [
              { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
              { id: 'gemini-weekly', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · Weekly', remainingPct: 91.2, usedPct: 8.8, resetsAt: new Date(Date.now() + 5.4 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
            ],
          },
          {
            key: '3p',
            title: 'Claude & GPT (shared)',
            models: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B'],
            windows: [
              { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 18, usedPct: 82, resetsAt: new Date(Date.now() + 42 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
              { id: '3p-weekly', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · Weekly', remainingPct: 49.6, usedPct: 50.4, resetsAt: new Date(Date.now() + 4.8 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
            ],
          },
        ],
        models: MODELS,
      },
    ],
  },
  exhausted: {
    ok: true,
    checkedAt: new Date().toISOString(),
    source: 'antigravity',
    fixture: true,
    accounts: [
      {
        label: 'demo@example.com',
        plan: 'Google AI Pro',
        email: 'demo@example.com',
        windows: [
          { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 6.5, usedPct: 93.5, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
          { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 0, usedPct: 100, resetsAt: new Date(Date.now() + 35 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
        ],
        pools: [
          {
            key: 'gemini',
            title: 'Gemini',
            models: ['Gemini 4 Hydrogen', 'Gemini 4 Argon'],
            windows: [
              { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 6.5, usedPct: 93.5, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
            ],
          },
          {
            key: '3p',
            title: 'Claude & GPT (shared)',
            models: ['Claude Opus 5.5', 'Claude Sonnet 5.5'],
            windows: [
              { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 0, usedPct: 100, resetsAt: new Date(Date.now() + 35 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
            ],
          },
        ],
        models: [],
      },
    ],
  },
  error: {
    ok: false,
    checkedAt: new Date().toISOString(),
    source: 'antigravity',
    fixture: true,
    accounts: [],
    needsT3Refresh: true,
    error: 'Antigravity 授权已失效，请在 T3 Code 连接设置中重新登录',
  },
  empty: { ok: true, checkedAt: new Date().toISOString(), source: 'antigravity', fixture: true, empty: true, accounts: [] },
  showcase: {
    ok: true,
    checkedAt: new Date().toISOString(),
    source: 'antigravity',
    fixture: false,
    accounts: [
      {
        label: 'alex@antigravity.dev',
        plan: 'Google AI Pro',
        tierId: 'g1-pro-tier',
        email: 'alex@antigravity.dev',
        credits: [{ type: 'GOOGLE_ONE_AI', minAmount: '50' }],
        windows: [
          { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
          { id: 'gemini-weekly', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · Weekly', remainingPct: 91.2, usedPct: 8.8, resetsAt: new Date(Date.now() + 5.4 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
          { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 100, usedPct: 0, resetsAt: null, untouched: true, windowDurationMins: 300, kind: '5h' },
          { id: '3p-weekly', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · Weekly', remainingPct: 49.6, usedPct: 50.4, resetsAt: new Date(Date.now() + 4.8 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
        ],
        pools: [
          {
            key: 'gemini',
            title: 'Gemini',
            models: ['Gemini 4 Hydrogen', 'Gemini 4 Argon', 'Gemini 4 Carbon', 'Gemini 4 Neon', 'Gemini 3.8 Flash'],
            windows: [
              { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 68.4, usedPct: 31.6, resetsAt: new Date(Date.now() + 3.2 * 3600_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
              { id: 'gemini-weekly', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · Weekly', remainingPct: 91.2, usedPct: 8.8, resetsAt: new Date(Date.now() + 5.4 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
            ],
          },
          {
            key: '3p',
            title: 'Claude & GPT (shared)',
            models: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B'],
            windows: [
              { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 100, usedPct: 0, resetsAt: null, untouched: true, windowDurationMins: 300, kind: '5h' },
              { id: '3p-weekly', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · Weekly', remainingPct: 49.6, usedPct: 50.4, resetsAt: new Date(Date.now() + 4.8 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
            ],
          },
        ],
        models: MODELS,
      },
    ],
  },
  showcaseExhausted: {
    ok: true,
    checkedAt: new Date().toISOString(),
    source: 'antigravity',
    fixture: false,
    accounts: [
      {
        label: 'alex@antigravity.dev',
        plan: 'Google AI Pro',
        email: 'alex@antigravity.dev',
        credits: [{ type: 'GOOGLE_ONE_AI', minAmount: '50' }],
        windows: [
          { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 6.5, usedPct: 93.5, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
          { id: 'gemini-weekly', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · Weekly', remainingPct: 54.0, usedPct: 46.0, resetsAt: new Date(Date.now() + 4.2 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
          { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 0, usedPct: 100, resetsAt: new Date(Date.now() + 35 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
          { id: '3p-weekly', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · Weekly', remainingPct: 21.5, usedPct: 78.5, resetsAt: new Date(Date.now() + 3.1 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
        ],
        pools: [
          {
            key: 'gemini',
            title: 'Gemini',
            models: ['Gemini 4 Hydrogen', 'Gemini 4 Argon', 'Gemini 4 Carbon'],
            windows: [
              { id: 'gemini-5h', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · 5-hour', remainingPct: 6.5, usedPct: 93.5, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
              { id: 'gemini-weekly', poolKey: 'gemini', poolTitle: 'Gemini', label: 'Gemini · Weekly', remainingPct: 54.0, usedPct: 46.0, resetsAt: new Date(Date.now() + 4.2 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
            ],
          },
          {
            key: '3p',
            title: 'Claude & GPT (shared)',
            models: ['Claude Opus 5.5', 'Claude Sonnet 5.5'],
            windows: [
              { id: '3p-5h', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · 5-hour', remainingPct: 0, usedPct: 100, resetsAt: new Date(Date.now() + 35 * 60_000).toISOString(), untouched: false, windowDurationMins: 300, kind: '5h' },
              { id: '3p-weekly', poolKey: '3p', poolTitle: 'Claude & GPT (shared)', label: 'Claude & GPT (shared) · Weekly', remainingPct: 21.5, usedPct: 78.5, resetsAt: new Date(Date.now() + 3.1 * 86400_000).toISOString(), untouched: false, windowDurationMins: 10080, kind: 'weekly' },
            ],
          },
        ],
        models: [],
      },
    ],
  },
};

const scenario = process.argv[2] && SCENARIOS[process.argv[2]] ? process.argv[2] : 'healthy';
const port = Number(process.argv[3] || 47899);
const payload = SCENARIOS[scenario];
const service = { getQuota: async () => payload };
createServer(service).listen(port, '127.0.0.1', () => {
  process.stdout.write('fixture ' + scenario + ' on http://127.0.0.1:' + port + '\n');
});
