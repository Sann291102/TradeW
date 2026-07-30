# Strategies

Strategy analysis and documentation. Each note documents a trading strategy — its purpose, conditions, rules, and how it maps to the Brain's strategy engine.

Use the **Strategy** template.

**Key constraint:** strategies here are documentation. Executable detection rules live in `services/sentinel/src/intelligence/strategy-rules.ts` and require code review. A strategy note can propose new rules, but those proposals must be implemented and tested in code before they become active.

The existing 8 built-in strategies and their ~40 rule predicates are defined in `strategy-engine.service.ts` and `strategy-rules.ts`.
