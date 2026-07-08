const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json());

db.initSchema();

// --- Endpoints CRUD ---
app.get('/api/endpoints', (req, res) => {
  const activeOnly = req.query.active === '1';
  res.json(db.getEndpoints(activeOnly));
});

app.post('/api/endpoints', (req, res) => {
  const { name, url, method, expected_status, check_interval_seconds } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  const r = db.insertEndpoint({ name, url, method, expected_status, check_interval_seconds });
  res.status(201).json({ id: r.lastInsertRowid, name, url });
});

app.get('/api/endpoints/:id', (req, res) => {
  const ep = db.getEndpoint(req.params.id);
  if (!ep) return res.status(404).json({ error: 'not found' });
  res.json(ep);
});

app.put('/api/endpoints/:id', (req, res) => {
  const ep = db.getEndpoint(req.params.id);
  if (!ep) return res.status(404).json({ error: 'not found' });
  db.updateEndpoint(req.params.id, req.body);
  res.json(db.getEndpoint(req.params.id));
});

app.delete('/api/endpoints/:id', (req, res) => {
  const r = db.deleteEndpoint(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// --- Checks / Metrics ---
app.get('/api/endpoints/:id/checks', (req, res) => {
  const ep = db.getEndpoint(req.params.id);
  if (!ep) return res.status(404).json({ error: 'not found' });
  const checks = db.getChecks(req.params.id, { limit: parseInt(req.query.limit) || 100, since: req.query.since });
  res.json(checks);
});

app.post('/api/endpoints/:id/checks', (req, res) => {
  const ep = db.getEndpoint(req.params.id);
  if (!ep) return res.status(404).json({ error: 'not found' });
  const { status_code, response_time_ms, is_up, error_message } = req.body;
  const r = db.insertCheck({ endpoint_id: req.params.id, status_code, response_time_ms, is_up, error_message });
  res.status(201).json({ id: r.lastInsertRowid });
});

app.get('/api/endpoints/:id/metrics', (req, res) => {
  const ep = db.getEndpoint(req.params.id);
  if (!ep) return res.status(404).json({ error: 'not found' });
  const hours = parseInt(req.query.hours) || 24;
  res.json(db.getMetrics(req.params.id, hours));
});

// --- Alerts ---
app.get('/api/alerts', (req, res) => {
  const opts = { endpoint_id: req.query.endpoint_id, acknowledged: req.query.acknowledged, limit: parseInt(req.query.limit) || 50 };
  res.json(db.getAlerts(opts));
});

app.post('/api/alerts', (req, res) => {
  const { endpoint_id, alert_type, message } = req.body;
  if (!endpoint_id || !alert_type || !message) return res.status(400).json({ error: 'endpoint_id, alert_type, and message are required' });
  const r = db.insertAlert({ endpoint_id, alert_type, message });
  res.status(201).json({ id: r.lastInsertRowid });
});

app.put('/api/alerts/:id/acknowledge', (req, res) => {
  const r = db.acknowledgeAlert(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.json({ acknowledged: true });
});

// --- Dashboard ---
app.get('/api/dashboard/summary', (req, res) => {
  res.json(db.getDashboardSummary());
});

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API server running on port ${PORT}`));

module.exports = app;