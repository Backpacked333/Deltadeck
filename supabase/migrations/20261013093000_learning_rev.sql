-- The curriculum is compare-and-set on a revision (audit F09). Each device
-- saved the whole document and the account kept whichever claimed the later
-- time, by the device's own clock: two devices' work never met, and the one
-- that lost was gone. Now a write names the revision it was based on, as
-- curriculum_rev = that + 1; anything else is refused with 40001, and the
-- client reads the account's copy, merges it with its own
-- (src/curriculum/core/merge.ts) and writes again. A client from before
-- this migration names no revision, so its curriculum writes are refused
-- rather than silently replacing newer work (it shows them as not saved).
--
-- curriculum_reset_at is the latest time any device reset its curriculum:
-- a merge drops work from before it, so a device that missed the reset
-- cannot bring that work back. It only moves forward.

alter table public.learning_state
  add column curriculum_rev bigint not null default 0,
  add column curriculum_reset_at timestamptz;

-- learning_state_newer as in *_practice_history.sql, with the curriculum
-- compare-and-set instead of the newer time winning. The trainer document
-- keeps the newer write; the clear and reset times only move forward.
create or replace function private.learning_state_newer() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.trainer_updated_at is not null
     and (new.trainer_updated_at is null
          or new.trainer_updated_at < old.trainer_updated_at) then
    new.trainer := old.trainer;
    new.trainer_updated_at := old.trainer_updated_at;
  end if;
  if new.curriculum is distinct from old.curriculum then
    if new.curriculum_rev is distinct from old.curriculum_rev + 1 then
      raise exception 'curriculum changed since revision % (a stale write)',
        old.curriculum_rev
        using errcode = '40001';
    end if;
  else
    -- An unchanged document keeps its revision and its time.
    new.curriculum_rev := old.curriculum_rev;
    new.curriculum_updated_at := old.curriculum_updated_at;
  end if;
  new.curriculum_reset_at :=
    greatest(old.curriculum_reset_at, new.curriculum_reset_at);
  new.hands_cleared_at := greatest(old.hands_cleared_at, new.hands_cleared_at);
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.learning_state_newer()
  from public, anon, authenticated;
