-- Les fonctions de déclencheur des notifications ne s'appellent pas en direct
-- (elles ne servent qu'aux déclencheurs, qui n'ont pas besoin de ce droit).
revoke all on function public.commando_notif_rdv_trg() from public, anon, authenticated;
revoke all on function public.commando_notif_semaine_trg() from public, anon, authenticated;
revoke all on function public.commando_notif_veille_trg() from public, anon, authenticated;
