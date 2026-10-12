-- F07: BYPASSRLS is not permission to bypass certificate-gated settlement.
-- Definer-owned writers (apply_rating and abandonment accounting) retain access.
revoke all on table public.ratings, public.rating_history
  from public, anon, authenticated, service_role;

-- Table revocation alone does not remove independently granted column rights.
do $$
declare
  target regclass;
  columns text;
begin
  for target in select unnest(array['public.ratings'::regclass, 'public.rating_history'::regclass]) loop
    select string_agg(quote_ident(attname), ', ' order by attnum) into columns
      from pg_attribute where attrelid = target and attnum > 0 and not attisdropped;
    execute format('revoke all (%s) on table %s from public, anon, authenticated, service_role', columns, target);
  end loop;
end $$;

grant select on table public.ratings, public.rating_history
  to anon, authenticated, service_role;
