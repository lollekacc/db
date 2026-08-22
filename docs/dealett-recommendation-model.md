# Dealett Recommendation Model

This document is the business specification for Dealett's mobile recommendation experience across the homepage quiz, AI chat, offer calculator, result cards, and cart handoff.

## Mission

Dealett should help each customer choose the best-fitting mobile subscription at the best effective value available through Dealett. The cheapest subscription is not automatically the best choice, and no subscription is expected to include every feature.

Every recommendation must therefore explain:

- which confirmed customer needs it satisfies;
- its normal monthly subscription price;
- its effective value after confirmed benefits such as replaced streaming costs and the future gift-card value;
- why Dealett selected it;
- the important features or benefits it does not include;
- whether the customer can order it now under the target operator's sales window.

The customer makes the final choice after seeing those trade-offs. Dealett must not hide a cheaper alternative or describe a plan as universally best.

## Two-Stage Experience

The website may show an initial recommendation after the essential questions, followed by a refined recommendation after streaming and travel questions.

### Initial recommendation

The initial result uses:

1. number of people/subscriptions;
2. current operator and remaining binding time for each person;
3. mobile-data need;
4. current mobile subscription cost.

It must be labelled as an initial result when streaming and travel preferences have not been collected.

### Refined recommendation

The refined result additionally uses:

5. paid streaming services and their actual monthly costs;
6. travel region and, for travel outside the EU/EES, whether the customer values data only or data plus local calls.

The refined result replaces the initial result and explains what changed.

## Why Each Question Exists

### 1. Number of people

The number of people determines whether Dealett should compare an individual subscription or a family/group arrangement, how additional-user prices apply, and whether different people can switch at different times.

### 2. Current operator and binding time

The current operator determines the customer's future gift-card value tier for each target operator:

- moving to a different operator means new-customer status and the maximum applicable gift-card tier;
- selecting `Annan / ingen` means the customer is treated as new to every target operator;
- staying with the same operator remains eligible for a gift card, but at a lower future value tier;
- a group can contain a mixture of new and existing customers, so the future value may be mixed.

Gift-card amounts are not finalized. Until real values are supplied, every amount remains `XXX kr`; calculations must not invent or estimate a numeric gift-card value.

Remaining binding time determines whether Dealett can sell the target operator now:

- Tele2 can accept an order when no more than 2 months remain;
- Telia, Telenor, and Tre can accept an order when no more than 3 months remain;
- a person outside the target operator's window cannot be sold that offer yet;
- for a group, eligible people may be compared separately while ineligible people wait, when the target plan supports that group size;
- remaining old subscription costs, notice periods, add-ons, and device payments must be included when data is available.

Unknown binding time must be communicated as requiring verification before purchase; it must never be presented as confirmed eligibility.

### 3. Mobile-data need

Data need prevents customers from paying for unused data while ensuring the recommended plan still covers their expected use. A plan below the confirmed requirement is not a valid fit; a larger plan may still be shown when it wins on total value, but the extra data must not be presented as savings by itself.

### 4. Current mobile price

The current mobile cost provides the baseline for showing how much Dealett can save or whether a better-featured option costs more. The comparison must distinguish:

- normal plan price;
- effective monthly value;
- estimated or exact current cost;
- monthly and 24-month difference;
- any higher cost accepted in exchange for features the customer values.

### 5. Streaming

Streaming affects effective value only when all of the following are true:

- the customer says they already pay for the service;
- the customer supplies its monthly cost;
- the recommended plan includes that exact service;
- the included service can replace the separate cost.

Only matched services are deducted. Unmatched services remain part of the customer's costs and must appear as a trade-off. Streaming value is deducted once from the new plan's effective cost; it must not also be added to the original mobile-price baseline.

### 6. Travel and international use

Travel questions identify plans whose roaming features justify a different price/value trade-off:

- travel within the EU/EES considers included calls, SMS, and roaming;
- travel outside the EU/EES considers included data;
- when relevant, Dealett distinguishes data only from data plus local calls;
- a plan that does not cover the stated travel need may still be shown as a cheaper alternative, but the missing capability and likely add-on requirement must be explicit.

## Calculation Principles

The comparison term is 24 months unless the business rules are intentionally revised.

The effective comparison uses:

`new plan cost over 24 months + eligible overlap costs + fees - finalized gift-card amount - matched streaming replacement value`

This is compared with the customer's current mobile subscription cost over the same period. Placeholder gift-card values contribute `0 kr` to numeric calculations until finalized values exist.

The calculation must use normal monthly plan prices and known one-time fees. It must never manufacture a discount, gift-card amount, coverage claim, or included feature.

## Ranking and Alternatives

At minimum, results should distinguish:

- best total value for the confirmed needs;
- lowest normal monthly price that still satisfies essential eligibility and data requirements;
- best travel fit when travel matters;
- best streaming fit when replaceable streaming costs exist;
- one best candidate per operator when the customer asks to see all operators.

If one plan wins several categories, the UI may combine those labels but should still show a distinct useful alternative where possible.

## Result-Card Contract

Every recommendation card shown by the homepage quiz or chat must carry enough information for an informed choice:

- result label, such as `Bast varde` or `Lagst manadspris`;
- operator, plan, data amount, people count, and binding period;
- normal monthly price and effective monthly value when different;
- current-cost comparison and whether it is estimated;
- gift-card placeholder and future value tier without inventing an amount;
- matched streaming replacement value;
- travel capabilities relevant to the customer;
- ordering eligibility or wait/partial-switch status;
- a concise reason for selection;
- benefits and explicit trade-offs.

The call to action must not imply that an ineligible person can order before the target operator's sales window.

## Chat Behaviour

The AI chat uses the same calculation and business rules as the homepage quiz. It may explain any question before continuing and must allow customers to pause, change topic, cancel, or start over.

General questions about Dealett, trust, coverage, gift cards, operators, or broadband should be answered directly. The mobile qualification flow should begin or resume only when the customer asks for a personalized mobile/family recommendation or clearly answers an active qualification question.

The AI may explain calculated recommendations but may not replace, override, or invent calculator results.

## Current Placeholders and Future Data

The following are intentionally unresolved and must remain explicit:

- numeric gift-card values by operator, plan, and customer-status tier;
- final same-operator versus new-customer gift-card amounts;
- any operator policy not represented in the plan catalog;
- exact address-level coverage or availability outside the supported coverage/address tools.

When those values are finalized, update the machine-readable rules and plan catalog first, then update this document and the related tests in the same change.
