# Transaction Aggregation API

A focused **full-stack financial transaction aggregation** project built with **Java 21 / Spring Boot, React, PostgreSQL and Apache Kafka**. It combines transactions from three deterministic mock providers and the platform's transaction event feed, normalises records to a common model, categorises them, deduplicates repeat imports and provides query/reporting APIs and a browser dashboard.

**Submission track:** Full Stack  
**Programming languages:** Java, JavaScript (React), SQL  
**Repository:** Publish this folder to a **public GitHub repository**, then provide that URL to the coordinator. No repository has been created or published automatically.

## What is in scope

| Component | Responsibility |
| --- | --- |
| `aggregation-service` | The main API: mock-source imports, transaction normalisation/categorisation/deduplication, SQL-backed analytics and Kafka consumer/outbox |
| `customer-service` | Demo customer identity/reference data for scoping financial records |
| `account-service` | Account metadata and account-to-customer ownership checks |
| `transaction-service` | Demo first-party transaction creation; publishes Kafka events imported by the aggregator |
| `api-gateway` | Single entry point for APIs and a **demo-only** JWT session endpoint |
| `frontend` | React dashboard for customer/account setup, mock imports, summaries, category analysis, trends, filtering and pagination |
| `postgres`, `kafka`, `db-init` | Persistent databases, Apache Kafka KRaft broker and idempotent database initialization |

Fraud detection, fraud cases, statement generation, notifications and unrelated backend applications have been removed. **Kafka remains**: transaction events are ingested asynchronously; the aggregation service also uses its own transactional outbox for publishing events.

## Architecture

```text
React browser -> nginx -> Spring API gateway
                              |-- customer-service ------ PostgreSQL
                              |-- account-service ------- PostgreSQL
                              |-- transaction-service --- PostgreSQL -- Kafka transaction.events --+
                              |-- aggregation-service --- PostgreSQL <-----------------------------+
                                      ^
                                      | Bank feed / Card network / Open banking
                                      | (three deterministic mock adapters)
```

Each Java service owns its Flyway migrations and database. The aggregator validates account ownership through the account service; source adapters are independently replaceable. Imports persist normalised rows, track duplicates and produce categorised, queryable aggregate data. Using the same account, source, seed, dates and count is a convenient way to demonstrate idempotent re-import behaviour.

## Prerequisites

- Docker Engine / Docker Desktop and Docker Compose v2
- Recommended: **8 GB RAM** available to Docker
- Optional for local development: Java 21, Maven 3.9+, Node.js 22+

No running database, Kafka broker or JDK is needed on the host when using Docker.

## Build and run (Docker)

```bash
cp .env.example .env
```

Edit `.env` and replace `POSTGRES_PASSWORD`, `DB_PASSWORD` (use the **same value**) and `AGGREGATION_JWT_SECRET` (at least 32 unpredictable bytes). For example, generate secrets with `openssl rand -hex 32`.

```bash
docker compose up -d --build --wait
docker compose ps
```

- **UI:** http://localhost:5173
- **API gateway:** http://localhost:8000
- **Aggregation service health:** http://localhost:8088/actuator/health
- **Gateway health:** http://localhost:8000/actuator/health
- **Kafka:** localhost:9092 (inside Docker: `kafka:19092`)
- **PostgreSQL:** localhost:5433 (inside Docker: `postgres:5432`)

If you are behind a corporate TLS-inspecting proxy, Maven image builds optionally accept a Docker BuildKit truststore secret; see `scripts/dev/generate-truststore.sh`. Normal builds do **not** require a truststore file.

To stop containers while retaining data:

```bash
docker compose down
```

**Caution:** `docker compose down -v` deletes local Postgres and Kafka data.

## Try the end-to-end workflow

1. Open the UI. Expand **New demo customer**, enter a name/email and create it (or choose a previously created customer).
2. Create a **Savings account** or choose an existing account.
3. Select `BANK_FEED`, `CARD_NETWORK` or `OPEN_BANKING`, choose dates, a count from 1–2000 and a deterministic seed.
4. Click **Import source**. Repeat for other providers. The dashboard refreshes totals, categories, daily trend and paginated transactions.
5. Repeat an identical import to see duplicates skipped. Adjust the direction or category filters to exercise the query API.

The customer-session endpoint used by the UI is deliberately a **local demonstration mechanism**. It accepts an arbitrary customer ID without identity verification and **must not be publicly exposed or used for real financial data**. Production deployment requires an actual OIDC/OAuth2 identity provider, independently verified identity, proper gateway authorization, secrets management, HTTPS, and network controls.

## API reference

Public-in-demo customer/account setup uses `/api/v1/customers`, `/api/v1/accounts` and `/api/v1/session`. Aggregation endpoints require a bearer token:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/aggregation/sources` | Available mock adapters |
| `POST` | `/api/v1/aggregation/imports` | Import source records for an owned account |
| `GET` | `/api/v1/aggregation/transactions` | Pageable transactions; filters: `accountId`, `customerId`, `category`, `direction`, `source`, `status`, `from`, `to`, `page`, `size` |
| `GET` | `/api/v1/aggregation/transactions/{id}` | Normalised transaction detail |
| `GET` | `/api/v1/aggregation/accounts/{accountId}/summary` | Debit, credit and net totals |
| `GET` | `/api/v1/aggregation/customers/{customerId}/summary` | Customer-level totals |
| `GET` | `/api/v1/aggregation/accounts/{accountId}/categories` | Categorisation breakdown |
| `GET` | `/api/v1/aggregation/customers/{customerId}/categories` | Customer categorisation breakdown |
| `GET` | `/api/v1/aggregation/accounts/{accountId}/trends` | Time buckets; `granularity=DAY\|MONTH` |
| `GET` | `/api/v1/aggregation/customers/{customerId}/trends` | Customer time trends |
| `GET` | `/api/v1/aggregation/accounts/{accountId}/velocity` | Time-window activity/peaks |
| `GET` | `/api/v1/aggregation/customers/{customerId}/velocity` | Customer-level velocity |
| `GET` | `/api/v1/aggregation/summary` | Platform summary, **staff JWT only** |

Customer-scoped endpoints and import authorization use the `customer_id` in the JWT; platform-wide summaries remain staff-only. Default report period is the last 30 days; supported range is up to 731 days. Transaction page size must be 1–200.

### Example commands

Create a customer:

```bash
curl -sS -X POST http://localhost:8000/api/v1/customers \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Alex","lastName":"Example","email":"alex@example.test","clientType":"INDIVIDUAL"}'
```

Copy the returned `id` into `CUSTOMER_ID`, then create an account:

```bash
CUSTOMER_ID='paste-customer-uuid-here'
curl -sS -X POST http://localhost:8000/api/v1/accounts \
  -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUSTOMER_ID\",\"accountType\":\"SAVINGS\"}"
```

Copy its `id` into `ACCOUNT_ID`. Issue a **demo-only** customer token:

```bash
ACCOUNT_ID='paste-account-uuid-here'
TOKEN=$(curl -sS -X POST http://localhost:8000/api/v1/session \
  -H 'Content-Type: application/json' -d "{\"customerId\":\"$CUSTOMER_ID\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -sS http://localhost:8000/api/v1/aggregation/sources \
  -H "Authorization: Bearer $TOKEN"
curl -sS -X POST http://localhost:8000/api/v1/aggregation/imports \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d "{\"accountId\":\"$ACCOUNT_ID\",\"source\":\"BANK_FEED\",\"from\":\"2026-11-01\",\"to\":\"2026-11-23\",\"count\":100,\"seed\":42}"
curl -sS "http://localhost:8000/api/v1/aggregation/accounts/$ACCOUNT_ID/summary" \
  -H "Authorization: Bearer $TOKEN"
```

## Test and validate

Java unit tests are located beside each service under `src/test`. From the repository root:

```bash
for service in customer-service account-service transaction-service aggregation-service api-gateway; do
  (cd "$service" && mvn -B test) || exit 1
done
```

Build and lint the React app:

```bash
cd frontend
npm ci
npm run build
npm run lint
```

Integration smoke checks (requires the running Docker Compose stack):

```bash
curl --fail http://localhost:8000/actuator/health
curl --fail http://localhost:8088/actuator/health
docker compose ps
```

Then exercise the example import, verify totals/rows and re-import the same seed to check duplicate handling. Kafka monitoring is available with the bundled Kafka CLI:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
```

### Architectural considerations and limits

- **Fault tolerance:** service-owned persistence, Flyway migrations, Kafka consumer retries and transactional outbox; Kafka is a single-node **local-dev** broker, not a HA cluster.
- **Consistency:** transaction-service Kafka ingestion is asynchronous; data may appear after a short delay. Mock-import ingestion is synchronous.
- **Correctness:** repeat-source and cross-source deduplication, explicit counted status, category classification and date-scoped summaries.
- **Security:** account ownership validated for customer queries and imports; the demo session issuer is not suitable as production authentication. Gateway customer/account creation endpoints are likewise a demo fixture.
- **Operations:** multi-stage Dockerfiles, non-root Java containers, health checks, bounded logs and environment-based secrets. Observability, external IdP integration, authorization at the gateway and multi-node Kafka are appropriate next steps for a deployed production system.
- **Data:** all records are synthetic. No actual banking APIs, real customer data or bank trademarks are required to run this submission.

## Submission checklist

- Publish this directory in a **public GitHub repository** after reviewing it for any private credentials or unwanted files.
- Include the public URL in your email to the coordinator.
- Specify **Java / JavaScript / SQL** and **Full Stack**.
- Explain architectural trade-offs (independent source adapters, deduplication, asynchronous Kafka events, scoped access and data consistency) at the interview.

> **Verification status:** The code was refactored from the supplied archive; this environment does not provide Docker or Maven, so a complete container startup and Java test run were **not executed here**. Run the listed checks before submission.
