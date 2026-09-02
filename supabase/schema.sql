-- ============================================================
--  Rex Seller — Schéma Supabase (base de données + sécurité)
-- ============================================================
--  À exécuter UNE FOIS dans Supabase :
--    Dashboard  ->  SQL Editor  ->  New query  ->  coller ce
--    fichier entier  ->  Run.
--
--  Ce script crée :
--    * la table « profiles »  (un profil par utilisateur, avec
--      son rôle et son responsable = manager_id)
--    * la table « rendez_vous » (les livrets de découverte)
--    * la règle de visibilité hiérarchique (Row-Level Security) :
--      chacun voit SES rendez-vous + ceux de toutes les personnes
--      situées SOUS lui dans l'organigramme.
--
--  Hiérarchie des rôles :
--    rro  (Responsable Régional)  >  ca (Chef d'Agence)
--        >  ro (Responsable Opérationnel)  >  commercial
-- ============================================================

-- ------------------------------------------------------------
-- 1) Table des profils
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  role        text not null default 'commercial'
              check (role in ('rro','ca','ro','commercial')),
  manager_id  uuid references public.profiles(id) on delete set null,
  agence      text,
  created_at  timestamptz not null default now()
);

comment on table public.profiles is 'Profil métier de chaque utilisateur (rôle + rattachement hiérarchique).';
comment on column public.profiles.manager_id is 'Responsable direct (le niveau au-dessus dans l''organigramme).';

-- ------------------------------------------------------------
-- 2) Table des rendez-vous (livrets de découverte)
-- ------------------------------------------------------------
create table if not exists public.rendez_vous (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  societe     text default '',
  date_rdv    date,
  data        jsonb not null default '{}'::jsonb,
  affaire     jsonb not null default '{"active":false,"data":{}}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists rendez_vous_author_idx on public.rendez_vous(author_id);
create index if not exists rendez_vous_updated_idx on public.rendez_vous(updated_at desc);

comment on table public.rendez_vous is 'Livrets de découverte. author_id = le commercial propriétaire du RDV.';

-- ------------------------------------------------------------
-- 3) Fonction de visibilité hiérarchique
--    can_view(viewer, author) = vrai si « viewer » a le droit de
--    voir les RDV de « author », c.-à-d. si viewer EST author ou
--    est l'un de ses responsables (en remontant l'organigramme).
--    SECURITY DEFINER : la fonction lit profiles sans repasser
--    par la RLS (évite toute récursion de politique).
-- ------------------------------------------------------------
create or replace function public.can_view(_viewer uuid, _author uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive chain as (
    -- niveau 0 : l'auteur lui-même
    select _author as id, 0 as depth
    union all
    -- on remonte vers le responsable, niveau par niveau
    select p.manager_id, chain.depth + 1
    from public.profiles p
    join chain on p.id = chain.id
    where p.manager_id is not null
      and chain.depth < 12            -- garde-fou anti-boucle
  )
  select exists (select 1 from chain where id = _viewer);
$$;

revoke all on function public.can_view(uuid, uuid) from public;
grant execute on function public.can_view(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 4) Mise à jour automatique de updated_at
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_rendez_vous_touch on public.rendez_vous;
create trigger trg_rendez_vous_touch
  before update on public.rendez_vous
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 5) Création automatique d'un profil à l'inscription
--    Chaque nouvel utilisateur (créé depuis le Dashboard ou par
--    invitation) obtient un profil « commercial » par défaut.
--    L'administrateur ajuste ensuite son rôle et son manager_id.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 6) Row-Level Security
-- ------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.rendez_vous enable row level security;

-- --- profiles : lecture de soi + de tout son sous-arbre ---
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using ( public.can_view(auth.uid(), id) );

-- (Aucune politique d'écriture sur profiles : la gestion des
--  comptes/hiérarchie se fait côté administration. Sans policy
--  INSERT/UPDATE/DELETE, ces opérations sont refusées par défaut.)

-- --- rendez_vous : lecture hiérarchique, écriture par le seul propriétaire ---
drop policy if exists rdv_select on public.rendez_vous;
create policy rdv_select on public.rendez_vous
  for select to authenticated
  using ( public.can_view(auth.uid(), author_id) );

drop policy if exists rdv_insert on public.rendez_vous;
create policy rdv_insert on public.rendez_vous
  for insert to authenticated
  with check ( author_id = auth.uid() );

drop policy if exists rdv_update on public.rendez_vous;
create policy rdv_update on public.rendez_vous
  for update to authenticated
  using ( author_id = auth.uid() )
  with check ( author_id = auth.uid() );

drop policy if exists rdv_delete on public.rendez_vous;
create policy rdv_delete on public.rendez_vous
  for delete to authenticated
  using ( author_id = auth.uid() );

-- ============================================================
--  FIN DU SCHÉMA
-- ============================================================
--
--  ÉTAPE SUIVANTE — créer les comptes et l'organigramme :
--
--  a) Créer les utilisateurs dans le Dashboard :
--        Authentication -> Users -> Add user
--     (renseigner l'email pro + un mot de passe provisoire).
--     Un profil « commercial » est créé automatiquement.
--
--  b) Renseigner rôle + rattachement. Exemple d'organigramme :
--
--     -- Le RRO (tout en haut, pas de manager)
--     update public.profiles
--       set role='rro', full_name='Nom RRO'
--       where email = 'rro@exemple.fr';
--
--     -- Un CA rattaché au RRO
--     update public.profiles
--       set role='ca', full_name='Nom CA1',
--           manager_id = (select id from public.profiles where email='rro@exemple.fr')
--       where email = 'ca1@exemple.fr';
--
--     -- Un RO rattaché à ce CA
--     update public.profiles
--       set role='ro', full_name='Nom RO',
--           manager_id = (select id from public.profiles where email='ca1@exemple.fr')
--       where email = 'ro1@exemple.fr';
--
--     -- Un commercial rattaché à ce RO
--     update public.profiles
--       set role='commercial', full_name='Nom Commercial',
--           manager_id = (select id from public.profiles where email='ro1@exemple.fr')
--       where email = 'com1@exemple.fr';
--
--  Chacun verra alors automatiquement ses RDV + ceux de tout
--  son sous-arbre, sans autre réglage.
-- ============================================================


-- ============================================================
--  SYSTÈME DE TICKETS (demandes / bugs)
--  ------------------------------------------------------------
--  Tout utilisateur peut créer un ticket ; seuls l'auteur et le
--  « développeur dédié » (profiles.is_dev = true) peuvent le lire.
-- ============================================================

-- Marqueur « développeur dédié » sur les profils
alter table public.profiles add column if not exists is_dev boolean not null default false;

-- Le ticket n'est visible que par son auteur et par le dev dédié.
create or replace function public.is_dev(_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_dev from public.profiles where id = _uid), false);
$$;
revoke all on function public.is_dev(uuid) from public;
grant execute on function public.is_dev(uuid) to authenticated;

create table if not exists public.tickets (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid references public.profiles(id) on delete set null,
  author_name  text,
  author_email text,
  subject      text not null,
  message      text not null,
  status       text not null default 'ouvert' check (status in ('ouvert','en_cours','resolu')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tickets_created_idx on public.tickets(created_at desc);

drop trigger if exists trg_tickets_touch on public.tickets;
create trigger trg_tickets_touch
  before update on public.tickets
  for each row execute function public.touch_updated_at();

alter table public.tickets enable row level security;

drop policy if exists tickets_insert on public.tickets;
create policy tickets_insert on public.tickets
  for insert to authenticated with check (author_id = auth.uid());

drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select to authenticated
  using (author_id = auth.uid() or public.is_dev(auth.uid()));

drop policy if exists tickets_update on public.tickets;
create policy tickets_update on public.tickets
  for update to authenticated
  using (public.is_dev(auth.uid())) with check (public.is_dev(auth.uid()));

drop policy if exists tickets_delete on public.tickets;
create policy tickets_delete on public.tickets
  for delete to authenticated using (public.is_dev(auth.uid()));

-- Désigner le développeur dédié (à adapter) :
--   update public.profiles set is_dev = true where email = 'scott.heitgen@rex-rotary.fr';
