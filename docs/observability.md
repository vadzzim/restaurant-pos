# Prometheus observability

The API exposes Prometheus text format at `GET /metrics`. The surface is intentionally small: six
metric families tied to concrete operator decisions, with bounded labels only. It complements the
existing correlated JSON logs rather than attempting to replace them.

| Metric                                      | Type and labels                                 | Source                         | Operator question                                         |
| ------------------------------------------- | ----------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| `pos_api_http_requests_total`               | Counter: `method`, route pattern, status code   | Fastify response hook          | Is traffic or the error rate changing?                    |
| `pos_api_http_request_duration_seconds`     | Histogram: the same bounded labels              | Fastify response hook          | Which API surface is slow?                                |
| `pos_api_mutations_total`                   | Counter: mutation outcome                       | Common mutation reply boundary | Are conflicts, duplicates, or rejected writes increasing? |
| `pos_api_websocket_connections`             | Gauge                                           | Socket.IO adapter              | Does this replica have expected live-client presence?     |
| `pos_delivery_items`                        | Gauge: pipeline (`outbox` or `print`) and state | PostgreSQL at scrape time      | Is durable work pending, failed, or dead-lettered?        |
| `pos_outbox_oldest_unpublished_age_seconds` | Gauge                                           | PostgreSQL at scrape time      | Is event publication falling behind?                      |

The route-pattern label comes from Fastify's matched route, not the request URL, so order IDs and
other unbounded values never enter the time-series identity. Mutation outcomes are a closed enum.
There are no tenant, order, terminal, mutation, event, or trace labels.

The two delivery gauges share one aggregate PostgreSQL query per scrape. Normal API requests do not
run that query. HTTP and mutation counters are process-local, as Prometheus expects; scrape every
API replica and aggregate in queries. The durable delivery gauges report the same database-backed
truth from each replica, so dashboards should use `max` rather than `sum` across instances.

Starter alerting rules are in [`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml). They cover
the strongest actionable signals available in this repository: an old unpublished event and either
delivery pipeline entering a dead-letter state. A production deployment would add a Prometheus
scrape configuration, Alertmanager routing, Kafka consumer-lag export, and distributed tracing;
those deployment concerns are intentionally not claimed here.
