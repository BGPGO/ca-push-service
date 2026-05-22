-- Rodar UMA VEZ no Supabase SQL Editor do projeto FinHub (pbtheffdoebfryttkyge)
-- Cria a tabela de auditoria do pipeline ca-push-service

CREATE TABLE IF NOT EXISTS public.bgp_pipeline_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  cnpj TEXT,
  client_name TEXT,
  crm_contract_id TEXT,
  step TEXT NOT NULL,       -- watcher_scan | ca_customer | ca_scheduled_sale | ca_discount | ca_setup | finhub_client | finhub_client_product | finhub_pit_wall | upsell
  action TEXT NOT NULL,     -- attempt | create | update | reuse | skip
  status TEXT NOT NULL,     -- ok | error | skipped | reused | pending
  detail TEXT,
  payload JSONB,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON public.bgp_pipeline_audit (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_cnpj ON public.bgp_pipeline_audit (cnpj);
CREATE INDEX IF NOT EXISTS idx_audit_run ON public.bgp_pipeline_audit (run_id);
CREATE INDEX IF NOT EXISTS idx_audit_status ON public.bgp_pipeline_audit (status, ts DESC) WHERE status = 'error';

ALTER TABLE public.bgp_pipeline_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_audit" ON public.bgp_pipeline_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "team_read_audit" ON public.bgp_pipeline_audit
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.role = 'team')
  );

-- Verificar:
-- SELECT count(*), max(ts) FROM public.bgp_pipeline_audit;
