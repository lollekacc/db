CREATE TABLE partner_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'demo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text UNIQUE,
  email text,
  display_name text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('employee', 'partner', 'customer', 'system')),
  partner_organization_id uuid REFERENCES partner_organizations(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invited')),
  demo_identity boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_type = 'partner') = (partner_organization_id IS NOT NULL))
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES app_users(id),
  employee_number text UNIQUE,
  title text,
  manager_employee_id uuid REFERENCES employees(id),
  security_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  system_role boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  description text,
  sensitive boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type text NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'partner_organization', 'team')),
  scope_id uuid,
  assigned_by uuid REFERENCES app_users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (user_id, role_id, scope_type, scope_id)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_memberships (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, employee_id)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  preferred_language text NOT NULL DEFAULT 'sv',
  classification text NOT NULL DEFAULT 'customer',
  duplicate_review_status text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  identity_type text NOT NULL,
  normalized_hash text NOT NULL,
  display_mask text,
  verified_at timestamptz,
  source text NOT NULL,
  UNIQUE (identity_type, normalized_hash)
);

CREATE TABLE customer_contact_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contact_type text NOT NULL CHECK (contact_type IN ('email', 'phone', 'other')),
  value_encrypted text NOT NULL,
  normalized_hash text NOT NULL,
  display_mask text,
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, contact_type, normalized_hash)
);

CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address_type text NOT NULL DEFAULT 'home',
  line1_encrypted text,
  line2_encrypted text,
  postal_code text,
  city text,
  country_code char(2) NOT NULL DEFAULT 'SE',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz
);

CREATE TABLE customer_duplicate_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_customer_id uuid NOT NULL REFERENCES customers(id),
  candidate_customer_id uuid NOT NULL REFERENCES customers(id),
  score numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'completed')),
  approved_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (primary_customer_id <> candidate_customer_id)
);

CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  partner_organization_id uuid UNIQUE REFERENCES partner_organizations(id),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_key text NOT NULL UNIQUE,
  schema_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'scheduled', 'active', 'expired', 'archived')),
  source text NOT NULL,
  source_hash text NOT NULL,
  effective_from timestamptz,
  effective_to timestamptz,
  published_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  stable_key text NOT NULL,
  product_type text NOT NULL CHECK (product_type IN ('mobile', 'broadband')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, stable_key)
);

CREATE TABLE plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id),
  catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text,
  data_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  monthly_price_minor bigint NOT NULL CHECK (monthly_price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'SEK',
  binding_months integer NOT NULL DEFAULT 0 CHECK (binding_months >= 0),
  effective_from timestamptz,
  effective_to timestamptz,
  state text NOT NULL CHECK (state IN ('draft', 'scheduled', 'active', 'expired', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version),
  UNIQUE (plan_id, catalog_version_id)
);

CREATE TABLE benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE,
  name text NOT NULL,
  benefit_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE benefit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benefit_id uuid NOT NULL REFERENCES benefits(id),
  version integer NOT NULL,
  configuration jsonb NOT NULL,
  state text NOT NULL,
  effective_from timestamptz,
  effective_to timestamptz,
  UNIQUE (benefit_id, version)
);

CREATE TABLE plan_version_benefits (
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  benefit_version_id uuid NOT NULL REFERENCES benefit_versions(id),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plan_version_id, benefit_version_id)
);

CREATE TABLE streaming_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE plan_version_streaming_services (
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  streaming_service_id uuid NOT NULL REFERENCES streaming_services(id),
  tier text,
  included boolean NOT NULL DEFAULT true,
  PRIMARY KEY (plan_version_id, streaming_service_id)
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'scheduled', 'active', 'expired', 'archived')),
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz,
  effective_to timestamptz,
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, version)
);

CREATE TABLE rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE,
  name text NOT NULL,
  rule_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id),
  version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'scheduled', 'active', 'expired', 'archived')),
  definition jsonb NOT NULL,
  effective_from timestamptz,
  effective_to timestamptz,
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, version)
);

CREATE TABLE rule_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id uuid NOT NULL REFERENCES rule_versions(id),
  object_type text NOT NULL,
  object_id uuid,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'expired')),
  requested_by uuid REFERENCES app_users(id),
  approved_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE application_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  classification text NOT NULL DEFAULT 'internal',
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  module text NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, module, name)
);

CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  channel text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, event_key, channel)
);

CREATE INDEX customer_contacts_customer_idx ON customer_contact_methods(customer_id);
CREATE INDEX plan_versions_effective_idx ON plan_versions(state, effective_from, effective_to);
CREATE INDEX campaign_versions_effective_idx ON campaign_versions(state, effective_from, effective_to);
CREATE INDEX rule_versions_effective_idx ON rule_versions(state, effective_from, effective_to);
