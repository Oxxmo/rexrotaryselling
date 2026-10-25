-- ============================================================
--  Rex Commando — 7/ Familles de métiers et mémoire des thématiques
-- ------------------------------------------------------------
--  * commando_parametres.familles : pour chaque famille d'offres Rex,
--    « privilegier », « neutre » (défaut) ou « exclure ». La veille doit
--    rattacher la majorité de ses propositions aux familles privilégiées
--    et aucune à une famille exclue.
--    Familles : impression, ged, cyber, telephonie, informatique.
--  * commando_thematiques.famille : famille d'offre de la thématique.
--  La veille reçoit désormais toutes les thématiques des 8 dernières
--  semaines (retenues, proposées non retenues, écartées) et refuse une
--  proposition trop proche d'un titre déjà vu.
-- ============================================================

alter table public.commando_parametres
  add column if not exists familles jsonb not null default '{}'::jsonb;
comment on column public.commando_parametres.familles is
  'Par famille (impression, ged, cyber, telephonie, informatique) : privilegier | neutre | exclure.';

alter table public.commando_thematiques
  add column if not exists famille text
  check (famille is null or famille in ('impression','ged','cyber','telephonie','informatique'));
