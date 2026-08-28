CREATE TABLE internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES app_users(id),
  body text NOT NULL,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'partner', 'customer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  supersedes_note_id uuid REFERENCES internal_notes(id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_user_id uuid REFERENCES app_users(id),
  assigned_team_id uuid REFERENCES teams(id),
  object_type text,
  object_id uuid,
  due_at timestamptz,
  completed_at timestamptz,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE task_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  label text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  completed_by uuid REFERENCES app_users(id),
  completed_at timestamptz,
  UNIQUE (task_id, sequence)
);

CREATE TABLE mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  mentioned_user_id uuid NOT NULL REFERENCES app_users(id),
  mentioned_by uuid NOT NULL REFERENCES app_users(id),
  context text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number text NOT NULL UNIQUE,
  customer_id uuid REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  conversation_id uuid REFERENCES conversations(id),
  category text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL CHECK (status IN ('open', 'waiting_customer', 'waiting_internal', 'resolved', 'closed')),
  subject text NOT NULL,
  assigned_user_id uuid REFERENCES app_users(id),
  service_target_at timestamptz,
  escalated_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_case_id uuid NOT NULL UNIQUE REFERENCES support_cases(id),
  complaint_type text NOT NULL,
  received_at timestamptz NOT NULL,
  regulatory_deadline_at timestamptz,
  outcome text,
  compensation_minor bigint,
  currency char(3),
  resolved_at timestamptz
);

CREATE TABLE support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_case_id uuid NOT NULL REFERENCES support_cases(id),
  sender_type text NOT NULL CHECK (sender_type IN ('customer', 'employee', 'partner', 'system')),
  sender_id uuid,
  channel text NOT NULL,
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL,
  name text NOT NULL,
  classification text NOT NULL,
  storage_provider text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  content_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'available', 'quarantined', 'deleted')),
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  version integer NOT NULL,
  storage_key text NOT NULL,
  content_hash text NOT NULL,
  effective_from timestamptz,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

CREATE TABLE object_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES documents(id),
  access_level text NOT NULL DEFAULT 'internal',
  attached_by uuid REFERENCES app_users(id),
  attached_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_type, object_id, document_id)
);

CREATE TABLE generated_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id),
  report_type text NOT NULL,
  version integer NOT NULL,
  source_snapshot_hash text NOT NULL,
  archive_hash text,
  document_id uuid REFERENCES documents(id),
  payload jsonb NOT NULL,
  payload_encrypted text,
  status text NOT NULL CHECK (status IN ('queued', 'generated', 'failed')),
  generated_by uuid REFERENCES app_users(id),
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, report_type, version)
);

CREATE TABLE agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_organization_id uuid REFERENCES partner_organizations(id),
  provider_name text NOT NULL,
  agreement_type text NOT NULL,
  title text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL,
  terms_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE agreement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES agreements(id),
  version integer NOT NULL,
  document_id uuid REFERENCES documents(id),
  commission_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, version)
);

CREATE TABLE communication_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE,
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'notification')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE communication_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES communication_templates(id),
  version integer NOT NULL,
  subject_template text,
  body_template text NOT NULL,
  variable_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('draft', 'active', 'archived')),
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE customer_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  support_case_id uuid REFERENCES support_cases(id),
  template_version_id uuid REFERENCES communication_template_versions(id),
  channel text NOT NULL,
  recipient_mask text NOT NULL,
  rendered_subject text,
  rendered_body text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'mock_sent', 'provider_accepted', 'delivered', 'failed', 'cancelled')),
  simulated boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE communication_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  communication_id uuid NOT NULL REFERENCES customer_communications(id),
  attempt integer NOT NULL,
  provider text NOT NULL,
  provider_reference text,
  status text NOT NULL,
  error_code text,
  error_summary text,
  simulated boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (communication_id, attempt)
);

CREATE TABLE communication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  communication_id uuid NOT NULL REFERENCES customer_communications(id),
  event_type text NOT NULL,
  provider_event_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (communication_id, provider_event_id)
);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE,
  name text NOT NULL,
  adapter_type text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('disconnected', 'mock', 'sandbox', 'live', 'manual_only')),
  state text NOT NULL,
  configuration_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_configuration text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES integrations(id),
  job_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  cursor text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  simulated boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES integrations(id),
  external_event_id text NOT NULL,
  signature_valid boolean NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb,
  processing_status text NOT NULL CHECK (processing_status IN ('received', 'processed', 'failed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (integration_id, external_event_id)
);

CREATE TABLE background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue text NOT NULL,
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'retry', 'dead_letter', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);

CREATE TABLE analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_session_id text,
  customer_id uuid REFERENCES customers(id),
  conversation_id uuid REFERENCES conversations(id),
  order_id uuid REFERENCES orders(id),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_basis text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metric_definitions (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  formula text NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE gdpr_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  request_type text NOT NULL CHECK (request_type IN ('access', 'correction', 'restriction', 'deletion', 'anonymisation', 'portability', 'objection')),
  status text NOT NULL CHECK (status IN ('received', 'identity_pending', 'review', 'approval_pending', 'processing', 'completed', 'rejected', 'cancelled')),
  received_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  legal_review_required boolean NOT NULL DEFAULT true,
  assigned_user_id uuid REFERENCES app_users(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gdpr_request_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gdpr_request_id uuid NOT NULL REFERENCES gdpr_requests(id),
  action_type text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid REFERENCES app_users(id),
  executed_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz
);

CREATE TABLE retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_category text NOT NULL UNIQUE,
  retention_days integer NOT NULL CHECK (retention_days > 0),
  action text NOT NULL CHECK (action IN ('review', 'delete', 'anonymise', 'archive')),
  enabled boolean NOT NULL DEFAULT false,
  legal_review_required boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  placed_by uuid NOT NULL REFERENCES app_users(id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES app_users(id),
  released_at timestamptz
);

CREATE TABLE retention_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retention_policy_id uuid NOT NULL REFERENCES retention_policies(id),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'approved', 'executed', 'skipped', 'failed')),
  reason text,
  approved_by uuid REFERENCES app_users(id),
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  summary text,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_queue_idx ON tasks(status, priority, due_at);
CREATE INDEX support_cases_queue_idx ON support_cases(status, priority, service_target_at);
CREATE INDEX communications_customer_idx ON customer_communications(customer_id, created_at DESC);
CREATE INDEX jobs_poll_idx ON background_jobs(queue, status, available_at);
CREATE INDEX outbox_unpublished_idx ON outbox_events(created_at) WHERE published_at IS NULL;
CREATE INDEX analytics_funnel_idx ON analytics_events(event_type, occurred_at);
CREATE INDEX gdpr_queue_idx ON gdpr_requests(status, due_at);
