const { PlatformError } = require('./errors');

const ORDER_TRANSITIONS = Object.freeze({
  draft: ['submitted', 'cancelled', 'expired'],
  submitted: ['awaiting_customer_information', 'identity_consent_pending', 'ready_internal_review', 'fraud_review', 'cancelled', 'duplicate', 'customer_withdrew'],
  awaiting_customer_information: ['identity_consent_pending', 'ready_internal_review', 'cancelled', 'expired', 'customer_withdrew'],
  identity_consent_pending: ['ready_internal_review', 'awaiting_customer_information', 'cancelled', 'expired', 'customer_withdrew'],
  ready_internal_review: ['ready_operator_submission', 'awaiting_customer_information', 'fraud_review', 'rejected', 'cancelled', 'duplicate'],
  ready_operator_submission: ['submitted_manually_to_operator', 'ready_internal_review', 'cancelled'],
  submitted_manually_to_operator: ['operator_processing', 'activated', 'rejected', 'cancelled'],
  operator_processing: ['activated', 'rejected', 'cancelled', 'expired'],
  activated: ['completed', 'activation_reversed', 'cancelled'],
  activation_reversed: ['operator_processing', 'cancelled', 'completed'],
  fraud_review: ['ready_internal_review', 'rejected', 'cancelled', 'duplicate'],
  rejected: [],
  cancelled: [],
  expired: [],
  duplicate: [],
  customer_withdrew: [],
  completed: ['activation_reversed'],
});

const OPERATOR_TRANSITIONS = Object.freeze({
  not_ready: ['ready_for_submission'],
  ready_for_submission: ['submitted_manual', 'not_ready'],
  submitted_manual: ['processing', 'activated', 'rejected'],
  processing: ['activated', 'rejected', 'cancelled'],
  activated: ['activation_reversed'],
  activation_reversed: ['processing', 'cancelled'],
  rejected: [],
  cancelled: [],
});

const COMMISSION_TRANSITIONS = Object.freeze({
  not_expected: ['expected'],
  expected: ['confirmed', 'disputed', 'cancelled'],
  confirmed: ['paid', 'adjusted', 'reversed', 'disputed'],
  adjusted: ['confirmed', 'paid', 'reversed'],
  paid: ['clawed_back', 'reversed'],
  disputed: ['expected', 'confirmed', 'cancelled'],
  clawed_back: [],
  reversed: [],
  cancelled: [],
});

const GIFT_CARD_TRANSITIONS = Object.freeze({
  not_eligible: ['eligible'],
  eligible: ['waiting_period', 'approval_pending', 'cancelled'],
  waiting_period: ['approval_pending', 'cancelled'],
  approval_pending: ['approved', 'rejected'],
  approved: ['ordered_mock', 'cancelled'],
  ordered_mock: ['delivered_mock', 'failed_mock', 'cancelled'],
  failed_mock: ['ordered_mock', 'cancelled'],
  delivered_mock: ['reversed'],
  rejected: [],
  cancelled: [],
  reversed: [],
});

const MACHINES = Object.freeze({
  order: ORDER_TRANSITIONS,
  operator: OPERATOR_TRANSITIONS,
  commission: COMMISSION_TRANSITIONS,
  gift_card: GIFT_CARD_TRANSITIONS,
});

const assertTransition = (machineName, from, to) => {
  const machine = MACHINES[machineName];
  if (!machine || !Object.prototype.hasOwnProperty.call(machine, from)) {
    throw new PlatformError('INVALID_CURRENT_STATE', `Unknown ${machineName} state: ${from}`, 409);
  }
  if (!machine[from].includes(to)) {
    throw new PlatformError(
      'INVALID_STATE_TRANSITION',
      `Cannot transition ${machineName} from ${from} to ${to}`,
      409,
      { machine: machineName, from, to, allowed: machine[from] }
    );
  }
};

module.exports = {
  COMMISSION_TRANSITIONS,
  GIFT_CARD_TRANSITIONS,
  MACHINES,
  OPERATOR_TRANSITIONS,
  ORDER_TRANSITIONS,
  assertTransition,
};
