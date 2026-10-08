
# TierForge: Resilient Bulk Store Scoring & Tiering

**Take-Home Exercise — Tech Lead Hiring**

**Company:** Sigmoid

**Estimated effort:** 2–3 days

**Document type:** Original Assignment Requirements

**Purpose:** This document is the source of truth for the TierForge implementation. All development phases must refer to it before making architectural or implementation decisions.

> IMPORTANT: This file records the assignment requirements. Implementation decisions, assumptions, additional features, and technical designs should be documented separately in `docs/architecture.md` and `docs/implementation-plan.md`.

---

## 1. Context

You're building TierForge, a service that ingests a large list of stores, enriches each one with a few business metrics via a slow, rate-limited, and occasionally unreliable API, then scores and tiers every store (Large / Medium / Small) based on user-configurable weights.

That enrichment API is one we provide and candidates run entirely on their own machine — no internet access, account signup, or API key involved. It's built to behave like a flaky third-party dependency (latency, rate limits, random failures) purely so the resilience problem is real, not to require any actual external integration.

The interesting part isn't the enrichment metrics themselves (we've synthesized those) — it's building a job engine that reliably processes thousands of records against a flaky external dependency, and a scoring layer that stays fast and re-runnable independent of that slow ingestion.

---

## 2. What We're Evaluating

- **Architecture** — how cleanly the slow, unreliable enrichment step is separated from the fast, deterministic scoring/tiering step.
- **Resilience** — how the system behaves under the failure modes described in Section 5 (timeouts, transient errors, a worker going silent, a systemically broken run).
- **Concurrency correctness** — safe parallel processing without lost or duplicated work.
- **Code quality** — readability, naming, error handling, consistency.
- **Data modeling** — how jobs, chunks/units of work, raw enrichment results, and computed scores/tiers are represented in the DB.
- **Tests** — unit tests are not mandatory but are a strong positive signal, especially around retry/backoff logic, the scoring formula, and tiering boundaries.

You're free to use AI tools while building this.

The bar is on the output: code you can explain and defend in a follow-up conversation, not just code that compiles.

**Time box: 2–3 days of effort.**

See Section 6 for what's in vs. out of scope — this exercise is intentionally meatier than a CRUD app, so scope discipline matters.

---

## 3. Tech Stack

- **Frontend:** React preferred (any modern framework is acceptable).
- **Backend:** Python or Node.js preferred.
- **Database:** PostgreSQL preferred (any SQL database is acceptable).
- **The enrichment API:** We provide this (see Section 5) — do not build your own.

---

## 4. Functional Flow

### Step 1 — Upload Store List

- User uploads a CSV of stores (we provide a sample generator and a ready-made file — see Section 5).
- Perform basic header validation before accepting the file, with clear errors on failure.

#### Required CSV Columns

1. `store_id`
2. `store_name`
3. `address`
4. `city`
5. `state`
6. `country`

### Step 2 — Run Enrichment Job

On submit, a job is created that enriches every store by calling the provided Enrichment API (Section 5), which returns:

- `estimated_monthly_footfall`
- `estimated_monthly_revenue`
- `store_size_sqft`

The API is rate-limited and unreliable by design (see Section 5's failure modes).

Your job engine has to get all (or as many as possible) stores enriched despite that, without losing track of what succeeded, failed, or is still pending.

Expose a way to see job progress and, for any store that ultimately failed, why.

#### Example API Call

Full contract is in the simulator's own README.

**Request:**

`POST /enrich`

```json
{
  "store_id": "ST000001",
  "store_name": "Fresh Supermarket #1",
  "address": "71 Church Street",
  "city": "New Delhi",
  "state": "Delhi"
}
```

**Response:**

```json
{
  "store_id": "ST000001",
  "estimated_monthly_footfall": 18234,
  "estimated_monthly_revenue": 142033.50,
  "store_size_sqft": 6210
}
```

### Step 3 — Configure Scoring & Tiering

For each of the three enrichment metrics, the user sets via the UI:

- A threshold ("bar") — the minimum value that counts as strong for that metric.
- A weight (0–100%) for how much clearing that bar contributes to the score.

Weights should sum to 100%.

The user also sets the score thresholds that separate Large / Medium / Small tiers (e.g. Large ≥ 70%, Medium ≥ 40%, else Small).

Submitting this computes, for every successfully enriched store, a score and a tier:

- A store's score is the sum of the weights for every metric bar it clears (so it naturally lands between 0% and 100%).
- The tier follows from comparing that score to the tier thresholds.

This step must not call the Enrichment API again.

It should run only against data already fetched in Step 2, be fast, and be safely re-runnable any time the user changes bars, weights, or tier thresholds (e.g. to see how the tier breakdown shifts).

#### Worked Example

Suppose the user configures:

| Metric | Bar | Weight |
|---|---|---|
| Footfall | ≥ 15,000 | 50% |
| Revenue | ≥ 150,000 | 30% |
| Store size | ≥ 8,000 sqft | 20% |

Tier thresholds:

- Large: score ≥ 70%
- Medium: score ≥ 40%
- Small: score below 40%

#### Expected Results

| Store | Footfall | Revenue | Size (sqft) | Clears footfall bar? | Clears revenue bar? | Clears size bar? | Score | Tier |
|---|---|---|---|---|---|---|---|---|
| A | 40,000 | 400,000 | 18,000 | ✓ (+50) | ✓ (+30) | ✓ (+20) | 100% | Large |
| B | 20,000 | 100,000 | 5,000 | ✓ (+50) | ✗ (+0) | ✗ (+0) | 50% | Medium |
| C | 2,000 | 20,000 | 9,000 | ✗ (+0) | ✗ (+0) | ✓ (+20) | 20% | Small |

That's the whole calculation — no normalization, no ranges, just checking each bar and adding up the weights for the ones a store clears.

Note Store C clears one bar (size) but still lands in Small — clearing a bar only helps as much as its weight allows, so a single low-weight bar isn't enough to reach Medium on its own.

### Step 4 — Dashboard

The dashboard must include:

#### Job Status

- Stores enriched
- Stores failed
- Stores pending
- Failure reasons visible

#### Tier Breakdown

- Count of Large stores
- Count of Medium stores
- Count of Small stores

#### Store List

A store list showing:

- Store name
- Category-equivalent metrics
- Computed score
- Assigned tier

The store list must be filterable by tier.

---

## 5. What We Provide

### 5.1 Sample Data

- A sample data generator script.
- A ready-made 5,000-row CSV of synthetic stores.
- Attached separately.

### 5.2 Enrichment API Simulator

The Enrichment API simulator is a small standalone service, attached separately, with its own README.

It runs locally, entirely on the candidate's own machine.

No internet connection, account, or API key is needed.

Every candidate hits the same service with the same documented behavior.

#### Failure Mode 1 — Global Rate Limit

**Global rate limit: 5 requests/second.**

Calls beyond that get HTTP 429.

#### Failure Mode 2 — Transient API Failures

Approximately 10% of calls return HTTP 500.

These errors are transient and retryable.

#### Failure Mode 3 — Slow / Delayed Responses

Approximately 2% of calls take 45–60 seconds to respond before eventually succeeding.

This is long enough that a well-designed system should have already decided the original attempt was dead and moved on.

The system must therefore handle the original attempt's answer showing up late without corrupting anything.

#### Failure Mode 4 — Deterministic Results

Results for a given `store_id` are deterministic.

Calling the API twice for the same store ID returns the same metrics.

### Important Architectural Instruction

Architecturally, treat the simulator like a dependency you don't control.

Build real retry/backoff/timeout handling rather than special-casing it just because you know it's local.

---

## 6. Scope

### 6.1 In Scope — Core Requirements

#### Functional Workflow

Steps 1–4, end to end, against a single job at a time.

This includes:

1. Uploading a store CSV.
2. Running enrichment jobs.
3. Configuring and running scoring/tiering.
4. Viewing the dashboard.

#### Required Resilience

The job must tolerate:

**A. Transient failures**

- Retry failed attempts.
- Retries must be capped.

**B. Calls that never return in reasonable time**

- The work must be reclaimed.
- It must be retried elsewhere.
- Do not double-count if the original call eventually returns.

**C. Systemically broken runs**

- Stop retrying after a bounded number of attempts.
- Do not loop forever.
- Provide a clear terminal failure state.

### 6.2 Out of Scope — Bonus Only

These should be implemented only if time remains.

#### Bonus 1 — Multiple Concurrent Enrichment Jobs

Run multiple enrichment jobs concurrently while still honoring one shared global rate limit of 5 requests/second across all of them.

#### Bonus 2 — Full Restart Resumability

Kill the server mid-job, restart it, and the job continues without redoing completed work or losing track of in-flight work.

### Scope Discipline

Please don't spend core time on the bonus items at the expense of the core flow.

---

## 7. Deliverables

### 7.1 Git Repository

A Git repository submitted as a ZIP archive or repository link.

The repository must contain:

- Backend
- Frontend

### 7.2 README.md

README.md must include:

1. Setup/run instructions.
2. Instructions for running the provided Enrichment API simulator alongside the application.
3. A short note on architecture decisions.
4. Any known limitations or shortcuts taken due to time.

### 7.3 Sample Data Files

Include the sample data files provided by Sigmoid (attached separately).

### 7.4 Tests

Tests are optional but encouraged.

If tests are included, they must be runnable via a single documented command.

---

## End of Original Requirements

This document is the authoritative reference for the TierForge assignment.

Implementation choices, architecture diagrams, specific technologies, retry settings, database schema decisions, extra validation rules, and task breakdowns should be documented separately rather than presented as original assignment requirements.

The separately supplied simulator README is authoritative for its full API contract.
