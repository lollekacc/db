CREATE SEQUENCE order_number_sequence START 1;

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token_hash text NOT NULL,
  customer_id uuid REFERENCES customers(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned', 'failed', 'archived')),
  language text,
  source_page text,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  qualification jsonb NOT NULL DEFAULT '{}'::jsonb,
  flow_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  client_message_id text,
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content_text text,
  content_encrypted text,
  structured_content jsonb,
  language text,
  model_name text,
  related_message_id uuid REFERENCES conversation_messages(id),
  client_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence),
  CHECK ((content_text IS NOT NULL) <> (content_encrypted IS NOT NULL))
);

CREATE TABLE conversation_message_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_message_id uuid NOT NULL REFERENCES conversation_messages(id),
  action_type text NOT NULL CHECK (action_type IN ('correction', 'review', 'redaction_request', 'gdpr_restriction')),
  payload jsonb NOT NULL,
  actor_user_id uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL,
  version integer NOT NULL,
  content_hash text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stable_key, version)
);

CREATE TABLE ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  input_message_id uuid REFERENCES conversation_messages(id),
  output_message_id uuid REFERENCES conversation_messages(id),
  prompt_version_id uuid REFERENCES prompt_versions(id),
  run_type text NOT NULL CHECK (run_type IN ('qualification', 'reply', 'review', 'evaluation')),
  provider text NOT NULL,
  provider_response_id text,
  model_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'timed_out')),
  input_tokens integer,
  output_tokens integer,
  cost_minor bigint,
  currency char(3),
  duration_ms integer,
  error_code text,
  error_summary text,
  safety_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  simulated boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE conversation_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id),
  message_id uuid REFERENCES conversation_messages(id),
  event_type text NOT NULL,
  rating text,
  feedback_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selected_offer_id text NOT NULL,
  catalog_version_id uuid REFERENCES catalog_versions(id),
  rule_version_id uuid REFERENCES rule_versions(id),
  campaign_version_id uuid REFERENCES campaign_versions(id),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('demo', 'live', 'test')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (scope, key)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  public_reference text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  partner_organization_id uuid REFERENCES partner_organizations(id),
  quote_id uuid REFERENCES quotes(id),
  source text NOT NULL,
  overall_status text NOT NULL,
  operator_status text NOT NULL,
  commission_status text NOT NULL,
  gift_card_status text NOT NULL,
  support_status text NOT NULL DEFAULT 'none',
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  safe_technical_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE order_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  external_participant_id text,
  display_label text NOT NULL,
  given_name_encrypted text,
  family_name_encrypted text,
  current_operator text,
  binding_end date,
  requested_activation_date date,
  UNIQUE (order_id, sequence)
);

CREATE TABLE order_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  participant_id uuid REFERENCES order_participants(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  external_subscription_id text,
  product_type text NOT NULL,
  selected_operator_id uuid REFERENCES operators(id),
  selected_plan_key text NOT NULL,
  current_operator text,
  phone_number_encrypted text,
  phone_number_mask text,
  number_handling text,
  requested_activation_date date,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (order_id, sequence)
);

CREATE TABLE order_snapshots (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  catalog_version_key text NOT NULL,
  rule_version_key text NOT NULL,
  campaign_version_key text,
  offer_snapshot jsonb NOT NULL,
  price_snapshot jsonb NOT NULL,
  benefit_snapshot jsonb NOT NULL,
  calculation_inputs jsonb NOT NULL,
  calculation_outputs jsonb NOT NULL,
  calculation_explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  alternatives_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  full_snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  monthly_value_minor bigint NOT NULL CHECK (monthly_value_minor >= 0),
  gift_card_value_minor bigint NOT NULL DEFAULT 0 CHECK (gift_card_value_minor >= 0),
  commission_expected_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'SEK',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL,
  version text NOT NULL,
  document_type text NOT NULL,
  content_hash text,
  storage_key text,
  effective_from timestamptz,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stable_key, version)
);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  consent_document_id uuid REFERENCES consent_documents(id),
  consent_type text NOT NULL,
  document_key text NOT NULL,
  document_version text NOT NULL,
  accepted boolean NOT NULL,
  accepted_at timestamptz NOT NULL,
  text_hash text,
  evidence jsonb NOT NULL,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_conversation_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  archived_at timestamptz NOT NULL,
  message_count integer NOT NULL CHECK (message_count >= 0),
  first_sequence integer,
  last_sequence integer,
  archive_hash text NOT NULL,
  UNIQUE (order_id, conversation_id)
);

CREATE TABLE order_conversation_archive_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archive_id uuid NOT NULL REFERENCES order_conversation_archives(id),
  source_message_id uuid NOT NULL,
  sequence integer NOT NULL,
  role text NOT NULL,
  content_text text,
  content_encrypted text,
  structured_content jsonb,
  language text,
  model_name text,
  client_created_at timestamptz,
  original_created_at timestamptz NOT NULL,
  UNIQUE (archive_id, sequence),
  UNIQUE (archive_id, source_message_id),
  CHECK ((content_text IS NOT NULL) <> (content_encrypted IS NOT NULL))
);

CREATE TABLE order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid REFERENCES app_users(id),
  reason text NOT NULL,
  note text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operator_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
  from_status text, to_status text NOT NULL, actor_user_id uuid REFERENCES app_users(id),
  reason text NOT NULL, note text, correlation_id text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
  from_status text, to_status text NOT NULL, actor_user_id uuid REFERENCES app_users(id),
  reason text NOT NULL, note text, correlation_id text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gift_card_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
  from_status text, to_status text NOT NULL, actor_user_id uuid REFERENCES app_users(id),
  reason text NOT NULL, note text, correlation_id text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  operator_id uuid REFERENCES operators(id),
  entry_type text NOT NULL CHECK (entry_type IN ('expectation', 'confirmation', 'payment', 'adjustment', 'reversal', 'clawback')),
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'SEK',
  effective_at timestamptz NOT NULL DEFAULT now(),
  source_reference text,
  simulated boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_reconciliation_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'review', 'closed', 'reopened')),
  closed_by uuid REFERENCES app_users(id),
  closed_at timestamptz,
  UNIQUE (operator_id, period_start, period_end),
  CHECK (period_end >= period_start)
);

CREATE TABLE commission_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES commission_reconciliation_periods(id),
  order_id uuid REFERENCES orders(id),
  external_reference text,
  expected_minor bigint,
  confirmed_minor bigint,
  status text NOT NULL CHECK (status IN ('matched', 'mismatch', 'unmatched', 'resolved')),
  resolution jsonb,
  UNIQUE (period_id, external_reference)
);

CREATE TABLE gift_card_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  campaign_version_id uuid REFERENCES campaign_versions(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'SEK',
  status text NOT NULL,
  eligible_at timestamptz,
  waiting_until timestamptz,
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gift_card_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES gift_card_entitlements(id),
  entry_type text NOT NULL CHECK (entry_type IN ('entitlement', 'approval', 'provider_order', 'delivery', 'failure', 'cancellation', 'reversal')),
  amount_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'SEK',
  provider_reference text,
  simulated boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES app_users(id),
  actor_type text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  correlation_id text NOT NULL,
  summary jsonb,
  before_summary jsonb,
  after_summary jsonb,
  source_ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL,
  source_path text NOT NULL,
  source_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'dry_run')),
  records_seen integer NOT NULL DEFAULT 0,
  records_imported integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (source_type, source_hash)
);

CREATE TABLE legacy_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id uuid NOT NULL REFERENCES data_import_runs(id),
  source_type text NOT NULL,
  source_id text,
  payload jsonb NOT NULL,
  data_quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE INDEX conversation_messages_sequence_idx ON conversation_messages(conversation_id, sequence);
CREATE UNIQUE INDEX conversation_messages_client_id_idx ON conversation_messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX ai_runs_status_idx ON ai_runs(status, started_at DESC);
CREATE INDEX orders_queue_idx ON orders(overall_status, submitted_at DESC);
CREATE INDEX orders_partner_idx ON orders(partner_organization_id, submitted_at DESC);
CREATE INDEX orders_customer_idx ON orders(customer_id, submitted_at DESC);
CREATE INDEX order_status_history_idx ON order_status_history(order_id, created_at);
CREATE INDEX operator_status_history_idx ON operator_status_history(order_id, created_at);
CREATE INDEX commission_status_history_idx ON commission_status_history(order_id, created_at);
CREATE INDEX gift_card_status_history_idx ON gift_card_status_history(order_id, created_at);
CREATE INDEX audit_events_object_idx ON audit_events(object_type, object_id, created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at DESC);
