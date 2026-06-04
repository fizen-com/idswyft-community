-- Add verification_requests.completed_at
--
-- The verification pipeline writes `completed_at` to verification_requests
-- (restart reset and finalize in routes/newVerification.ts, mirrored from the
-- session state's completed_at). No prior migration declared this column, so
-- on any DB built strictly from migrations the writes failed silently
-- (Supabase ignores the returned error), which in turn broke /restart with a
-- spurious 409 (the optimistic-lock UPDATE referenced a non-existent column).
--
-- This adds the column so the writes succeed. Distinct from
-- processing_completed_at (engine processing timestamp).

ALTER TABLE verification_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
