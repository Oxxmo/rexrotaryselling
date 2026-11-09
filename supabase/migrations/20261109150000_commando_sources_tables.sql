-- ============================================================
--  Rex Commando — nouvelles sources de fiches (tables)
-- ------------------------------------------------------------
--  * commando_evenements : annonces BODACC des entreprises de la base
--    (changement de dirigeant, déménagement, rachat, procédure
--    collective, dissolution…). Signal « pourquoi appeler maintenant »
--    et exclusion des entreprises en difficulté ou fermées.
--  * commando_finances : dernier chiffre d'affaires publié (API
--    Recherche d'entreprises, rempli par l'import hebdomadaire).
--  * commando_passages : fiches « passées » par un commercial (hors
--    cible, fermée, doublon…) : elles disparaissent de la liste.
--  * commando_sources_requetes : suivi des requêtes pg_net vers les
--    annuaires publics (RGE ADEME, FINESS, BODACC).
--  * commando_contacts.source : + rge, finess.
--  * Paramètres : plancher de fiches neuves par commercial, délai
--    d'une fiche passée.
--  * Vue commando_entreprises_v : une entreprise en procédure
--    collective (12 mois) ou dissoute (24 mois) n'est plus éligible.
-- ============================================================

create table if not exists public.commando_evenements (
  id            text primary key,                 -- identifiant de l'annonce BODACC
  siren         text not null check (siren ~ '^[0-9]{9}$'),
  type          text not null check (type in ('dirigeant','demenagement','capital','activite','rachat',
                                              'etablissement','procedure','fermeture','autre')),
  libelle       text not null,
  date_parution date not null,
  details       jsonb not null default '{}'::jsonb,
  url           text,
  source        text not null default 'bodacc',
  importe_le    timestamptz not null default now()
);
comment on table public.commando_evenements is 'Annonces BODACC (Vienne) des entreprises de la base : signal d''appel et exclusions (procédures collectives, dissolutions).';
create index if not exists commando_evenements_siren_idx on public.commando_evenements(siren, date_parution desc);

create table if not exists public.commando_finances (
  siren        text primary key check (siren ~ '^[0-9]{9}$'),
  ca           bigint,
  resultat_net bigint,
  annee        int,
  maj_le       timestamptz not null default now()
);
comment on table public.commando_finances is 'Dernier chiffre d''affaires publié de l''unité légale (API Recherche d''entreprises, import hebdomadaire).';

create table if not exists public.commando_passages (
  siret         text primary key references public.commando_entreprises(siret) on delete cascade,
  commercial_id uuid references public.profiles(id) on delete set null,
  raison        text not null check (raison in ('hors_cible','fermee','doublon','pas_de_numero','autre')),
  passe_le      timestamptz not null default now(),
  jusqua        date not null,
  annule_le     timestamptz
);
comment on table public.commando_passages is 'Fiches passées par un commercial : retirées de la liste jusqu''à la date indiquée (sauf annulation).';

create table if not exists public.commando_sources_requetes (
  id         bigint primary key,                  -- identifiant pg_net
  source     text not null check (source in ('rge','finess','bodacc')),
  demande_le timestamptz not null default now(),
  traite_le  timestamptz,
  resultat   jsonb
);
comment on table public.commando_sources_requetes is 'Requêtes pg_net vers les annuaires publics (RGE ADEME, FINESS, BODACC) et leur traitement.';

alter table public.commando_evenements       enable row level security;
alter table public.commando_finances         enable row level security;
alter table public.commando_passages         enable row level security;
alter table public.commando_sources_requetes enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_evenements' and policyname = 'commando_evenements_select') then
    create policy commando_evenements_select on public.commando_evenements for select to authenticated
      using ( (select public.commando_est_membre(auth.uid())) );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_finances' and policyname = 'commando_finances_select') then
    create policy commando_finances_select on public.commando_finances for select to authenticated
      using ( (select public.commando_est_membre(auth.uid())) );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_passages' and policyname = 'commando_passages_select') then
    create policy commando_passages_select on public.commando_passages for select to authenticated
      using ( (select public.commando_est_membre(auth.uid())) );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_sources_requetes' and policyname = 'commando_sources_requetes_select') then
    create policy commando_sources_requetes_select on public.commando_sources_requetes for select to authenticated
      using ( (select public.commando_est_responsable(auth.uid())) );
  end if;
end $$;
-- Lecture seule pour les membres connectés ; aucune écriture directe
-- (tout passe par les fonctions SECURITY DEFINER), rien pour anon.
revoke all on public.commando_evenements, public.commando_finances, public.commando_passages,
              public.commando_sources_requetes from anon, authenticated;
grant select on public.commando_evenements, public.commando_finances, public.commando_passages,
                public.commando_sources_requetes to authenticated;

-- Sources de téléphone : saisie, OpenStreetMap, annuaire RGE (ADEME), FINESS.
alter table public.commando_contacts drop constraint if exists commando_contacts_source_check;
alter table public.commando_contacts add constraint commando_contacts_source_check
  check (source is null or source in ('manuel', 'osm', 'rge', 'finess'));
comment on column public.commando_contacts.source is 'manuel (saisi par un commercial), osm (OpenStreetMap), rge (annuaire RGE de l''ADEME) ou finess (fichier FINESS).';

alter table public.commando_parametres
  add column if not exists plancher_fiches_neuves int not null default 40
    check (plancher_fiches_neuves between 0 and 500),
  add column if not exists delai_passer_semaines int not null default 8
    check (delai_passer_semaines between 1 and 52);
comment on column public.commando_parametres.plancher_fiches_neuves is
  'Nombre minimal de fiches jamais appelées proposées à chaque commercial : si les sujets de la semaine en donnent moins, la liste est complétée par les meilleures fiches non classées.';
comment on column public.commando_parametres.delai_passer_semaines is
  'Durée (semaines) pendant laquelle une fiche passée disparaît de la liste (52 semaines pour « fermée » et « doublon »).';

-- Éligibilité : + pas de procédure collective depuis 12 mois, pas de
-- dissolution ni de cessation depuis 24 mois (annonces BODACC).
create or replace view public.commando_entreprises_v
with (security_invoker = true) as
  select e.*,
         cp.secteur_code, s.nom as secteur_nom, s.commercial_id,
         public.commando_anciennete(e.date_creation_ul, p.bornes_anciennete) as anciennete,
         (e.nouvelle_semaine is not null and e.nouvelle_semaine = public.commando_semaine_cible(current_date)) as est_nouvelle,
         c.telephone, c.email, coalesce(c.opposition, false) as opposition,
         (e.archived_at is null and not e.est_client and e.exclu_le is null and not coalesce(c.opposition, false)
          and not exists (select 1 from public.commando_evenements ev
                           where ev.siren = e.siren
                             and ((ev.type = 'procedure' and ev.date_parution > current_date - 365)
                               or (ev.type = 'fermeture' and ev.date_parution > current_date - 730)))) as eligible
    from public.commando_entreprises e
    left join public.commando_codes_postaux cp on cp.code_postal = e.code_postal
    left join public.commando_secteurs s on s.code = cp.secteur_code
    left join public.commando_contacts c on c.siret = e.siret
    cross join (select bornes_anciennete from public.commando_parametres where id) p;
grant select on public.commando_entreprises_v to authenticated;
