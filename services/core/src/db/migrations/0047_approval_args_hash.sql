-- An approval belongs to the call you saw (docs/permissions.md, "An approval belongs to the call you saw").
--
-- args_hash: SHA-256 of the canonical JSON of the arguments the approval asked about.
-- approved_args_hash: the same for what the person approved (their edited arguments, if they edited
--   them), set when the answer is "approve" and never otherwise.
--
-- A run that resumes under an approval runs the waiting call only if the call's arguments hash to
-- approved_args_hash. Approvals made before this migration have neither hash, so a call still waiting
-- on one asks again: it fails closed, once.
alter table core.approvals add column if not exists args_hash text;
alter table core.approvals add column if not exists approved_args_hash text;
