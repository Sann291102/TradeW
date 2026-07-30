# Generated Concepts

AI-proposed concepts awaiting human review.

The ingestion pipeline (Phase 2) generates concept proposals here when it identifies ideas in books or research that don't match existing `knowledge-base/` concepts. These are drafts — they require human review before promotion.

**Review workflow:**
1. AI generates a concept note here using the Concept template
2. Human reviews for accuracy, completeness, and compliance (no directive language)
3. If accepted, move to `01 Concepts/` and refine
4. When ready, promote to `knowledge-base/<domain>/<id>.yaml`
5. Run `npm run ontology:validate` then `npm run ontology:seed`

A generated concept that is rejected should be marked `status: rejected` with a note explaining why, not deleted (Rule 1).
