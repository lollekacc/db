# Market Verification Checklist

Use this checklist for manual verification only. Do not scrape automatically, do not invent prices, and do not mark any row `verified` unless the row has a current source URL and `lastChecked` date.

## Required Plan Fields

Every plan row in `data/plans.json` is prepared for these fields:

- `planName`
- `dataGb`
- `isUnlimited`
- `monthlyPrice`
- `campaignPrice`
- `campaignMonths`
- `normalPriceAfterCampaign`
- `bindingMonths`
- `noticePeriodMonths`
- `supports5G`
- `supportsEsim`
- `roamingEuGb`
- `speedCapMbps`
- `familyDiscountAvailable`
- `studentDiscountAvailable`
- `seniorDiscountAvailable`
- `youthDiscountAvailable`
- `sourceUrl`
- `lastChecked`
- `dataStatus`

## Operators And Categories

For each operator, verify these categories from official operator pages or explicit partner documentation:

| Operator | Categories to verify |
|---|---|
| Telia | Private mobile, family mobile, student, senior, youth/child if available, mobile broadband/5G broadband, business if present |
| Tele2 | Private mobile, family mobile, student, senior, youth/child if available, mobile broadband/5G broadband, business if present |
| Telenor | Private mobile, family mobile, student, senior, youth/child if available, mobile broadband/5G broadband, business if present |
| Tre | Private mobile, family mobile, student, senior, youth/child if available, mobile broadband/5G broadband, business if present |

## Manual Steps

1. Open the official operator page for the exact plan or category.
2. Confirm whether the category exists for that operator.
3. Copy the source URL into `sourceUrl` for plan rows or `sourceUrls` for operator rows.
4. Set `lastChecked` to the manual check date in `YYYY-MM-DD`.
5. Verify plan name, data, unlimited status, monthly price and campaign terms.
6. If a campaign price exists, verify both campaign length and normal price after campaign.
7. Verify binding time, notice period, 5G, eSIM, EU roaming and speed caps.
8. Verify segment flags for family, student, senior, youth and child offers.
9. Only then change `dataStatus` from `placeholder` to `verified`.

Run `npm run market:verification-report` after each manual update.
