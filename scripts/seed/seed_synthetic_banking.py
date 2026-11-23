#!/usr/bin/env python3
"""Idempotent synthetic seed for the Transaction Aggregation platform.

Runs as the "seeder" one-shot container in docker-compose.yml (python:3.12-alpine, standard
library only). It talks to the platform only through the API gateway, so it exercises the same
paths the frontend and the README use. It can also run on the host:

    GATEWAY_URL=http://localhost:8000/api/v1 python3 scripts/seed/seed_synthetic_banking.py

What it ensures exist (all data is synthetic; e-mail addresses use the reserved example.com domain):

  * SEED_CUSTOMER_COUNT customers (default 60); every tenth is a BUSINESS client
  * a SAVINGS account for each customer, plus a CHEQUE account for two thirds of them
  * an opening balance on each account (ledger funding endpoint)
  * about 110 ledger transactions per customer over the last ~15 months (salary, card, grocery,
    fuel, utilities, ATM, loan repayments). Credits are posted, so balances move.
  * a deterministic burst of small card purchases per customer, posted against the savings account
  * an aggregation import per account (BANK_FEED, CARD_NETWORK or OPEN_BANKING, rotated by customer),
    made with the customer's own session token, as the frontend does
  * CASE_COUNT cases in case-service (SEED-CASE-01 .. SEED-CASE-10), one for each of the first ten
    customers, linked to that customer's savings account
  * checks: every balance is readable, every import returns rows, and the transaction events that
    the ledger publishes over Kafka reach the aggregation service (polled for a bounded time)

Idempotency: every seeded ledger transaction description starts with "SEED <ref> ", where the ref
is stable (for example "C007-R012"). A run reads the refs already present on each account and only
creates the missing ones, so repeated runs and runs after a partial failure never duplicate ledger
data. Aggregation imports are keyed by seed and date window, and the platform itself skips rows it
has already counted. Customers and accounts are matched by e-mail and account type. Nothing
existing is modified.

Environment:
  GATEWAY_URL                  default http://localhost:8000/api/v1
  SEED_CUSTOMER_COUNT          default 60 (minimum 1)
  SEED_INGEST_WAIT_SECONDS     default 120, how long to wait for Kafka-delivered rows to appear

Exit status: 0 when the data set is complete and every check passed; 1 otherwise.
"""

import json
import os
import random
import socket
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

GATEWAY = os.environ.get("GATEWAY_URL", "http://localhost:8000/api/v1").rstrip("/")
CUSTOMER_COUNT = max(1, int(os.environ.get("SEED_CUSTOMER_COUNT", "60")))
INGEST_WAIT_SECONDS = int(os.environ.get("SEED_INGEST_WAIT_SECONDS", "120"))
ROUTINE_TXN_PER_CUSTOMER = 102
CASE_COUNT = 10
CASE_PREFIX = "SEED-CASE"
CASE_SUBJECTS = [
    "Disputed card purchase", "Duplicate debit order", "Unexpected fuel charge",
    "Salary deposit not received", "ATM withdrawal not dispensed", "Loan repayment query",
    "Utilities payment reversal", "EFT transfer on hold", "Account statement request",
    "Address change for statements",
]
CASE_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
IMPORT_COUNT = 60
IMPORT_WINDOW_DAYS = 90
SOURCES = ["BANK_FEED", "CARD_NETWORK", "OPEN_BANKING"]
WORKERS = 6
EMAIL_DOMAIN = "example.com"
CURRENCY = "ZAR"

FIRST_NAMES = ["Thandi", "Sipho", "Ayanda", "Pieter", "Naledi", "Johan", "Lerato", "Mpho",
               "Zanele", "Willem", "Kagiso", "Annelie", "Themba", "Corne", "Nomsa", "Ruan",
               "Palesa", "Hendrik", "Ntombi", "Jaco"]
LAST_NAMES = ["Dlamini", "Naidoo", "van der Merwe", "Mokoena", "Botha", "Khumalo", "Pillay",
              "Nel", "Ndlovu", "Smit", "Molefe", "Jacobs", "Maseko", "Coetzee", "Sithole",
              "Le Roux", "Mahlangu", "Fourie", "Radebe", "Erasmus"]

# (description, direction, min rand, max rand)
ROUTINE_TEMPLATES = [
    ("Salary deposit", "CREDIT", 9000, 38000),
    ("EFT transfer in", "CREDIT", 500, 8000),
    ("Card purchase", "DEBIT", 80, 2500),
    ("Grocery purchase", "DEBIT", 150, 1800),
    ("Fuel purchase", "DEBIT", 400, 1200),
    ("Utilities payment", "DEBIT", 300, 2400),
    ("ATM withdrawal", "DEBIT", 200, 2000),
    ("Loan repayment", "DEBIT", 2500, 7000),
]


class SeedError(RuntimeError):
    pass


# --------------------------------------------------------------------------- HTTP helpers
def call(method, path, body=None, token=None):
    """Returns (status, parsed_json_or_None). Retries GET requests on 5xx and connection errors only;
    writes are never retried automatically, because a retry could duplicate a transaction. A failed
    write is counted, and the next run creates it, since every ledger write is keyed by its reference."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    attempts = 4 if method == "GET" else 1
    last_error = None
    # A name-resolution failure (EAI_AGAIN) means the request never left this process, so retrying it
    # is safe for writes too. It is retried separately from ordinary connection errors.
    dns_failures = 0
    attempt = 0
    while attempt < attempts:
        request = urllib.request.Request(GATEWAY + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
                return response.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                parsed = json.loads(raw) if raw else None
            except ValueError:
                parsed = {"message": raw[:300].decode("utf-8", "replace")}
            if error.code >= 500 and attempt < attempts - 1:
                attempt += 1
                time.sleep(1 + attempt)
                continue
            return error.code, parsed
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            last_error = error
            if isinstance(getattr(error, "reason", None), socket.gaierror) and dns_failures < 6:
                dns_failures += 1
                time.sleep(min(2 ** dns_failures, 20))
                continue
            attempt += 1
            time.sleep(1 + attempt)
    raise SeedError(f"{method} {path} unreachable: {last_error}")


def items(payload):
    """Accepts a bare list or a Spring page ({content: [...]})."""
    if payload is None:
        return []
    if isinstance(payload, dict) and isinstance(payload.get("content"), list):
        return payload["content"]
    return payload if isinstance(payload, list) else []


# --------------------------------------------------------------------------- synthetic data
def customer_spec(index: int) -> dict:
    first = FIRST_NAMES[index % len(FIRST_NAMES)]
    last = LAST_NAMES[(index * 7 + index // len(LAST_NAMES)) % len(LAST_NAMES)]
    if index % 10 == 9:
        return {
            "firstName": f"{last.split()[-1]} Logistics {index:03d}"[:100],
            "lastName": "Pty Ltd",
            "email": f"accounts.{index:03d}@{EMAIL_DOMAIN}",
            "phoneNumber": f"+2711{index:07d}",
            "clientType": "BUSINESS",
        }
    slug = last.lower().replace(" ", "")
    return {
        "firstName": first,
        "lastName": last,
        "email": f"{first.lower()}.{slug}.{index:03d}@{EMAIL_DOMAIN}",
        "phoneNumber": f"+2782{index:07d}",
        "clientType": "INDIVIDUAL",
    }


def money(rng: random.Random, low: int, high: int) -> str:
    return f"{rng.randint(low * 100, high * 100) / 100:.2f}"


def ref_of(description):
    """'SEED C007-R012 Card purchase' -> 'C007-R012'; anything else -> None."""
    if description and description.startswith("SEED ") and len(description.split()) >= 2:
        return description.split()[1]
    return None


def plan_transactions(code: str, now: datetime, account_count: int):
    """Deterministic plan for one customer. The same customer always gets the same plan.
    Only credits are posted; debits stay pending, so the ledger never overdraws in the seed."""
    rng = random.Random(f"plan-{code}")
    plan = []
    for k in range(ROUTINE_TXN_PER_CUSTOMER):
        name, direction, low, high = rng.choice(ROUTINE_TEMPLATES)
        plan.append({
            "ref": f"{code}-R{k:03d}", "account": k % account_count, "type": direction,
            "amount": money(rng, low, high), "when": now - timedelta(days=rng.uniform(0, 450)),
            "name": name, "post": direction == "CREDIT",
        })
    for k in range(2):
        plan.append({
            "ref": f"{code}-HV{k}", "account": 0, "type": "DEBIT", "amount": "60000.00",
            "when": now - timedelta(days=rng.uniform(5, 450)),
            "name": "High-value transfer review", "post": False,
        })
    burst_start = now - timedelta(days=rng.uniform(20, 400))
    for k in range(6):
        plan.append({
            "ref": f"{code}-BU{k}", "account": 0, "type": "DEBIT", "amount": "45.00",
            "when": burst_start + timedelta(seconds=40 * k),
            "name": "Rapid card purchase", "post": True,
        })
    for entry in plan:
        if entry["when"] > now:
            entry["when"] = now - timedelta(minutes=1)
    return plan


# --------------------------------------------------------------------------- seeding steps
def list_customers():
    status, listing = call("GET", "/customers")
    if status != 200:
        raise SeedError(f"cannot list customers: {status} {listing}")
    return {c["email"].lower(): c for c in items(listing)}


def ensure_customers(summary):
    by_email = list_customers()
    for index in range(CUSTOMER_COUNT):
        spec = customer_spec(index)
        if spec["email"] in by_email:
            continue
        status, created = call("POST", "/customers", spec)
        if status == 201:
            by_email[spec["email"]] = created
            summary["customers_created"] += 1
        elif status == 409:
            # Created by someone else in the meantime; pick it up on the next listing.
            by_email = list_customers()
        else:
            summary["failures"].append(f"create customer {spec['email']}: {status} {created}")
    return [by_email[customer_spec(i)["email"]] for i in range(CUSTOMER_COUNT)
            if customer_spec(i)["email"] in by_email]


def ensure_accounts(index: int, customer: dict, summary) -> list:
    status, accounts = call("GET", f"/accounts/customer/{customer['id']}")
    accounts = items(accounts) if status == 200 else []
    have = {a.get("accountType") for a in accounts}
    wanted = ["SAVINGS"] + (["CHEQUE"] if index % 3 != 0 else [])
    for account_type in wanted:
        if account_type in have:
            continue
        status, created = call("POST", "/accounts", {"customerId": customer["id"], "accountType": account_type})
        if status == 201:
            accounts.append(created)
            summary["accounts_created"] += 1
        else:
            summary["failures"].append(f"open {account_type} for {customer['email']}: {status} {created}")
    return sorted(accounts, key=lambda a: (a.get("accountType") != "SAVINGS", a.get("accountNumber", "")))


def seed_customer(index: int, customer: dict, now: datetime) -> dict:
    """Seeds one customer's accounts and ledger. Runs in a worker thread; returns its own counters."""
    local = {"accounts_created": 0, "transactions_created": 0, "transactions_existing": 0,
             "funding_created": 0, "posted": 0, "failures": [], "accounts": []}
    code = f"C{index:03d}"
    accounts = ensure_accounts(index, customer, local)
    local["accounts"] = [a["id"] for a in accounts]
    if not accounts:
        return local
    existing = {}
    for account in accounts:
        status, txns = call("GET", f"/transactions/account/{account['id']}")
        refs = set()
        for t in items(txns) if status == 200 else []:
            ref = ref_of(t.get("description"))
            if ref:
                refs.add(ref)
        existing[account["id"]] = refs

    # Opening balance on each account: idempotent by its own reference and idempotency key.
    for ai, account in enumerate(accounts):
        ref = f"{code}-A{ai}-OPEN"
        if ref in existing[account["id"]]:
            local["transactions_existing"] += 1
            continue
        rng = random.Random(f"open-{code}-{ai}")
        status, body = call("POST", "/transactions/funding", {
            "accountId": account["id"], "entryKind": "OPENING_BALANCE",
            "amount": f"{rng.randint(15, 90) * 1000}.00", "currency": CURRENCY,
            "idempotencyKey": f"seed-{ref}", "description": f"SEED {ref} Opening balance"})
        if status in (200, 201):
            local["funding_created"] += 1
        else:
            local["failures"].append(f"opening balance {ref}: {status} {body}")

    for entry in plan_transactions(code, now, len(accounts)):
        account = accounts[entry["account"]]
        if entry["ref"] in existing[account["id"]]:
            local["transactions_existing"] += 1
            continue
        body = {
            "accountId": account["id"], "type": entry["type"], "amount": entry["amount"],
            "currency": CURRENCY, "description": f"SEED {entry['ref']} {entry['name']}",
            "syntheticSeed": True, "occurredAt": entry["when"].strftime("%Y-%m-%dT%H:%M:%S"),
        }
        status, created = call("POST", "/transactions", body)
        if status != 201:
            local["failures"].append(f"transaction {entry['ref']}: {status} {created}")
            continue
        local["transactions_created"] += 1
        if entry["post"]:
            status, body = call("POST", f"/transactions/{created['id']}/post")
            if status == 200:
                local["posted"] += 1
            else:
                local["failures"].append(f"post {entry['ref']}: {status} {body}")
    return local


def customer_token(customer_id: str):
    status, body = call("POST", "/session", {"customerId": customer_id})
    if status != 200 or not body or "token" not in body:
        raise SeedError(f"cannot open a session for customer {customer_id}: {status} {body}")
    return body["token"]


def aggregation_import(index: int, customer: dict, account_id: str, account_offset: int, today):
    """One aggregation import for one account, made with the customer's own session token."""
    result = {"imports": 0, "received": 0, "counted": 0, "duplicates": 0, "failures": []}
    token = customer_token(customer["id"])
    source = SOURCES[index % len(SOURCES)]
    body = {
        "accountId": account_id, "source": source,
        "from": (today - timedelta(days=IMPORT_WINDOW_DAYS - 1)).isoformat(), "to": today.isoformat(),
        "count": IMPORT_COUNT, "seed": index * 10 + account_offset,
    }
    status, imported = call("POST", "/aggregation/imports", body, token=token)
    if status != 200 or not imported:
        result["failures"].append(f"import {source} for {account_id}: {status} {imported}")
        return result
    result["imports"] = 1
    result["received"] = int(imported.get("received", 0))
    result["counted"] = int(imported.get("counted", 0))
    result["duplicates"] = int(imported.get("duplicatesSkipped", 0))
    if int(imported.get("failed", 0)) > 0 or int(imported.get("received", 0)) == 0:
        result["failures"].append(f"import {source} for {account_id}: {imported}")
    return result


# --------------------------------------------------------------------------- cases
def seed_cases(customers, accounts_by_customer, summary):
    """One case per customer for the first CASE_COUNT customers. Matched by subject, so re-runs add nothing."""
    status, listing = call("GET", f"/cases?q={CASE_PREFIX}&size=200")
    existing = {c.get("subject") for c in items(listing)} if status == 200 else set()
    for i, customer in enumerate(customers[:CASE_COUNT]):
        number = i + 1
        subject = f"{CASE_PREFIX}-{number:02d} {CASE_SUBJECTS[i % len(CASE_SUBJECTS)]}"
        if subject in existing:
            summary["cases_existing"] += 1
            continue
        account_ids = accounts_by_customer.get(customer["id"], [])
        if not account_ids:
            summary["failures"].append(f"case {subject}: customer {customer['email']} has no account")
            continue
        body = {
            "subject": subject,
            "description": f"Synthetic case {number:02d} for {customer['firstName']} {customer['lastName']}. "
                           "Created by the seeder for demonstration only.",
            "priority": CASE_PRIORITIES[i % len(CASE_PRIORITIES)],
            "caseType": "GENERAL_INQUIRY",
            "customerId": customer["id"],
            "accountId": account_ids[0],
            "owner": "Seed Analyst",
        }
        status, created = call("POST", "/cases", body)
        if status == 201:
            summary["cases_created"] += 1
        else:
            summary["failures"].append(f"case {subject}: {status} {created}")


# --------------------------------------------------------------------------- checks
def check_balances(accounts_by_customer, summary):
    for account_ids in accounts_by_customer.values():
        for account_id in account_ids:
            status, _ = call("GET", f"/transactions/account/{account_id}/balance")
            if status == 200:
                summary["balances_checked"] += 1
            else:
                summary["failures"].append(f"balance {account_id}: {status}")


def check_summaries(customer, accounts, summary, token):
    for account_id in accounts:
        status, totals = call("GET", f"/aggregation/accounts/{account_id}/summary", token=token)
        if status == 200 and totals and int(totals.get("transactionCount", 0)) > 0:
            summary["summaries_checked"] += 1
        else:
            summary["failures"].append(f"aggregation summary {account_id}: {status} {totals}")


def wait_for_kafka_ingestion(sample, summary):
    """Ledger events travel transaction-service -> Kafka -> aggregation-service. Poll until rows arrive."""
    if not sample:
        return
    customer, account_id = sample
    token = customer_token(customer["id"])
    deadline = time.time() + INGEST_WAIT_SECONDS
    while True:
        status, page = call("GET", f"/aggregation/transactions?accountId={account_id}&source=TRANSACTION_SERVICE&size=1",
                            token=token)
        total = int(page.get("totalElements", 0)) if status == 200 and isinstance(page, dict) else 0
        if total > 0:
            summary["kafka_rows_seen"] = total
            return
        if time.time() >= deadline:
            summary["failures"].append(
                f"no TRANSACTION_SERVICE rows reached aggregation-service for {account_id} "
                f"within {INGEST_WAIT_SECONDS}s")
            return
        time.sleep(3)


# --------------------------------------------------------------------------- main
def main() -> int:
    now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
    today = datetime.now(timezone.utc).date()
    summary = {
        "customers_target": CUSTOMER_COUNT, "customers_created": 0, "accounts_created": 0,
        "funding_created": 0, "transactions_created": 0, "transactions_existing": 0,
        "posted": 0, "imports": 0, "imported_rows_received": 0, "imported_rows_counted": 0,
        "imported_rows_already_present": 0, "balances_checked": 0, "summaries_checked": 0,
        "kafka_rows_seen": 0, "cases_created": 0, "cases_existing": 0, "failures": [],
    }

    print(f"seed: ensuring {CUSTOMER_COUNT} synthetic customers", flush=True)
    customers = ensure_customers(summary)
    print(f"seed: {len(customers)} synthetic customers present", flush=True)

    accounts_by_customer = {}
    customer_accounts = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(seed_customer, i, c, now): (i, c) for i, c in enumerate(customers)}
        done = 0
        for future in futures:
            local = future.result()
            done += 1
            for key in ("accounts_created", "transactions_created", "transactions_existing",
                        "funding_created", "posted"):
                summary[key] += local[key]
            summary["failures"].extend(local["failures"])
            index, customer = futures[future]
            accounts_by_customer[customer["id"]] = local["accounts"]
            customer_accounts[customer["id"]] = (index, customer)
            if done % 10 == 0 or done == len(customers):
                print(f"seed: {done}/{len(customers)} customers processed", flush=True)

    check_balances(accounts_by_customer, summary)

    print("seed: importing through aggregation-service", flush=True)
    import_jobs = []
    for customer_id, (index, customer) in customer_accounts.items():
        for offset, account_id in enumerate(accounts_by_customer.get(customer_id, [])):
            import_jobs.append((index, customer, account_id, offset))
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(aggregation_import, index, customer, account_id, offset, today)
                   for index, customer, account_id, offset in import_jobs]
        for future in futures:
            result = future.result()
            summary["imports"] += result["imports"]
            summary["imported_rows_received"] += result["received"]
            summary["imported_rows_counted"] += result["counted"]
            summary["imported_rows_already_present"] += result["duplicates"]
            summary["failures"].extend(result["failures"])

    print("seed: creating demonstration cases", flush=True)
    seed_cases(customers, accounts_by_customer, summary)

    if customers:
        first = customers[0]
        first_accounts = accounts_by_customer.get(first["id"], [])
        if first_accounts:
            token = customer_token(first["id"])
            check_summaries(first, first_accounts, summary, token)
            wait_for_kafka_ingestion((first, first_accounts[0]), summary)

    problems = []
    if len(customers) < CUSTOMER_COUNT:
        problems.append(f"only {len(customers)} of {CUSTOMER_COUNT} customers exist")
    if summary["failures"]:
        problems.append(f"{len(summary['failures'])} operations failed")
    if summary["imports"] == 0:
        problems.append("no aggregation imports completed")
    if summary["cases_created"] + summary["cases_existing"] < CASE_COUNT:
        problems.append(f"only {summary['cases_created'] + summary['cases_existing']} of {CASE_COUNT} seeded cases exist")
    if summary["kafka_rows_seen"] == 0 and summary["failures"] == []:
        problems.append("the Kafka path into aggregation-service was not confirmed")

    print(json.dumps({k: v for k, v in summary.items() if k != "failures"}, indent=2))
    for failure in summary["failures"][:20]:
        print(f"seed: failure: {failure}", file=sys.stderr)
    if problems:
        for problem in problems:
            print(f"seed: CHECK FAILED: {problem}", file=sys.stderr)
        return 1
    print("seed: complete. Re-running this script is safe and adds nothing that already exists.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SeedError as error:
        print(f"seed: {error}", file=sys.stderr)
        sys.exit(1)
