REVOKE ALL ON public.m0_probe_public FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.m0_probe_public TO anon, authenticated, service_role;
