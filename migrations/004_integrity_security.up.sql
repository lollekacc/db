CREATE FUNCTION prevent_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER conversation_messages_immutable BEFORE UPDATE OR DELETE ON conversation_messages
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER order_snapshots_immutable BEFORE UPDATE OR DELETE ON order_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER order_conversation_archives_immutable BEFORE UPDATE OR DELETE ON order_conversation_archives
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER order_conversation_archive_messages_immutable BEFORE UPDATE OR DELETE ON order_conversation_archive_messages
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER order_status_history_immutable BEFORE UPDATE OR DELETE ON order_status_history
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER operator_status_history_immutable BEFORE UPDATE OR DELETE ON operator_status_history
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER commission_status_history_immutable BEFORE UPDATE OR DELETE ON commission_status_history
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER gift_card_status_history_immutable BEFORE UPDATE OR DELETE ON gift_card_status_history
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER commission_entries_immutable BEFORE UPDATE OR DELETE ON commission_entries
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER gift_card_entries_immutable BEFORE UPDATE OR DELETE ON gift_card_entries
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();
CREATE TRIGGER webhook_events_no_delete BEFORE DELETE ON webhook_events
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_touch_updated BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER customers_touch_updated BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER support_cases_touch_updated BEFORE UPDATE ON support_cases
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER tasks_touch_updated BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER integrations_touch_updated BEFORE UPDATE ON integrations
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_actor_scope ON orders
USING (
  current_setting('app.actor_type', true) IN ('employee', 'system')
  OR (
    current_setting('app.actor_type', true) = 'partner'
    AND partner_organization_id::text = NULLIF(current_setting('app.partner_organization_id', true), '')
  )
  OR (
    current_setting('app.actor_type', true) = 'customer'
    AND customer_id::text = NULLIF(current_setting('app.customer_id', true), '')
  )
  OR (
    current_setting('app.actor_type', true) = 'public_capture'
    AND id::text = NULLIF(current_setting('app.capture_order_id', true), '')
  )
)
WITH CHECK (
  current_setting('app.actor_type', true) IN ('employee', 'system')
  OR (
    current_setting('app.actor_type', true) = 'partner'
    AND partner_organization_id::text = NULLIF(current_setting('app.partner_organization_id', true), '')
  )
);

CREATE POLICY orders_public_capture_insert ON orders
FOR INSERT
WITH CHECK (
  current_setting('app.actor_type', true) = 'public_capture'
  AND id::text = NULLIF(current_setting('app.capture_order_id', true), '')
);

ALTER TABLE commission_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_entries_actor_scope ON commission_entries
USING (EXISTS (SELECT 1 FROM orders WHERE orders.id = commission_entries.order_id))
WITH CHECK (
  current_setting('app.actor_type', true) = 'public_capture'
  OR EXISTS (SELECT 1 FROM orders WHERE orders.id = commission_entries.order_id)
);

CREATE VIEW order_queue_view WITH (security_barrier = true, security_invoker = true) AS
SELECT
  o.id,
  o.order_number,
  o.submitted_at,
  o.customer_id,
  o.partner_organization_id,
  os.offer_snapshot->>'operator' AS operator,
  os.offer_snapshot->>'title' AS plan_name,
  (SELECT count(*) FROM order_subscriptions s WHERE s.order_id = o.id) AS subscription_count,
  os.monthly_value_minor,
  os.gift_card_value_minor,
  o.overall_status,
  o.operator_status,
  o.commission_status,
  o.gift_card_status,
  o.updated_at,
  o.version
FROM orders o
JOIN order_snapshots os ON os.order_id = o.id;

CREATE INDEX conversations_customer_idx ON conversations(customer_id, created_at DESC);
CREATE INDEX quotes_expiry_idx ON quotes(expires_at);
CREATE INDEX consent_records_order_idx ON consent_records(order_id, accepted_at);
CREATE INDEX commission_entries_order_idx ON commission_entries(order_id, effective_at);
CREATE INDEX gift_card_entries_entitlement_idx ON gift_card_entries(entitlement_id, created_at);
