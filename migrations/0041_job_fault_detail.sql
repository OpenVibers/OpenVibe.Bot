-- phase: expand
-- A failed job says why (11-28, Contracts 0.457.0): the Link's job_exit.detail when the worker could not run a job (no
-- runtime, a sandbox that would not start, an input that would not fetch). Run passes it on as the job's error.detail,
-- so the person is told instead of seeing their task move to another model without a reason.
ALTER TABLE run_jobs ADD COLUMN IF NOT EXISTS fault_detail text;
