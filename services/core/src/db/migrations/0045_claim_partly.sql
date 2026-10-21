-- Graded fact-check verdicts: a claim can now be "partly" right (rounded, approximate, true only in
-- part). Claims stored before this keep their verdicts; the nuance lives in the claim's check JSON.
alter table core.claims drop constraint if exists claims_verdict_check;
alter table core.claims add constraint claims_verdict_check
  check (verdict in ('verified','partly','unverified','contradicted','not_checkable'));
