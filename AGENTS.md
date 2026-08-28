# Backend Repository Working Rules

## Scope

- These rules apply to the Dealett backend repository and all files beneath this directory.
- Follow exactly what I ask for. Do not change unrelated things.
- When I ask to change, improve, replace, or redesign something, the existing code for that specific thing may and should be rewritten or removed as necessary.
- If something included in my request is already implemented correctly, leave it untouched.
- Do not implement additional features or improvements I did not request. You may briefly suggest them after completing the task.

## Decisions

- If there are multiple reasonable implementation choices and the difference is minor, choose the simplest and safest approach that fits the existing codebase.
- If a decision could materially affect design, functionality, architecture, or behavior, ask me before deciding.
- If you are not confident that you correctly understand what I want, ask me before implementing.
- When I specify what I want but not how to program it, choose the simplest and safest technically appropriate implementation that fits the existing codebase.
- Prefer existing tools and dependencies. Add a new dependency only when there is a meaningful technical reason.
- Prefer robust, production-quality implementations over quick but weaker solutions, while remaining within the requested scope.

## Existing Functionality

- Preserve existing functionality, interactions, data, and flows unless I explicitly request changing them.
- This also applies during backend refactors and API changes.
- If shared/global code must be changed, first understand where it is used and afterward verify the affected areas still work.
- If you notice an unrelated existing bug, do not fix it. Mention it to me afterward.
- If another problem must be fixed for my requested change to function correctly, fix only what is necessary.

## Refactoring And Cleanup

- Refactor existing code when necessary to implement the requested change properly, but do not refactor beyond the requested scope.
- When replacing an implementation, remove obsolete/dead code from the old implementation rather than leaving duplicate implementations behind.
- You may clean nearby pre-existing technical debt only when it is directly related to the code being changed.
- After completing the requested work, related technical cleanup is allowed, but unrelated cleanup or optimization is not.
- Do not add comments or documentation unless I explicitly request them.

## Verification

- Verify the requested change and directly affected functionality.
- Perform reasonably broader regression testing based on the scope and risk of the change, but do not automatically test the entire backend after every task.
- Before finishing, review your own diff and confirm every modification is related to the requested task.
- Remove or revert accidental and unnecessary changes.
- Scale investigation and verification to the task. For trivial/local changes, make the change and perform only proportionate checks. Do not run broad analysis or regression testing unnecessarily.
- For trivial, clearly scoped edits, use a fast path: inspect only the directly relevant file(s), make the smallest correct change, run only the minimum necessary verification, and stop. Do not perform broad repository searches, full-backend checks, or unrelated validation unless the change requires them.

## Cross-Repository Verification

- Trace customer-visible data changes from source data through API/normalization and the frontend renderer to actual browser output on every affected page.
- Test the exact requested names, prices, images, and interactions. Browser verification must confirm visible text, successful image loading, and relevant interaction states before and after user actions.
- Do not report completion until automated checks and rendered output agree.
- Add regression tests for confirmed bugs when practical.
- Review and show the complete relevant diff before committing.

## Recovery

- If your implementation causes regressions, first attempt to debug and correct the implementation.
- If the approach itself is causing problems, revert your own problematic changes and use a safer approach.

## Conflicts With These Rules

- If a future request from me explicitly conflicts with one of these permanent rules, do not silently override the rule. Ask me before proceeding with the conflicting instruction.

## Capability And Initiative

- These rules limit the scope of what you change, not the depth or quality of your work.
- Use your full available capabilities, tools, reasoning, testing, browser access, and technical expertise when they help complete the requested task.
- Investigate as broadly as necessary to understand the problem, but only modify what is within the approved scope.
- Do not choose an inferior implementation merely because it requires less work. Within the requested scope, aim for the best robust, production-quality solution.
