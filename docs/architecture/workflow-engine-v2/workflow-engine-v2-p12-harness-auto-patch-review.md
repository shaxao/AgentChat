# Harness Evolution P12 Review: Automatic Candidate Patch Generation

Date: 2026-07-08

## Scope

- Expanded Harness automatic patch generation beyond recurring failure promotion.
- Added an explicit auto-generation endpoint for candidate plans.
- Kept the system review-first: generated patches are not auto-applied.

## Implemented

- `POST /api/admin/harness/patches/auto-generate`
- `HarnessEvolutionService.autoGeneratePatches(...)`
- Automatic scan now covers:
  - recurring open/regression failure groups.
  - high-priority individual failures without an active patch.
- Patch payload now uses `harness.patch.v2` with:
  - recommendations
  - implementation plan
  - regression checklist
  - affected surfaces
  - failure samples
  - activation gate
- Admin UI bulk action now calls auto-generation and labels it as automatic candidate generation.

## Review Findings

- Passed: generated changes remain candidate plans requiring human review and regression before activation.
- Passed: AutoCode, skill matching, memory, workflow, streaming/rendering, quota/model, and security failure types have more specific guidance.
- Passed: backend compile succeeds.
- Passed: frontend build succeeds.
- Residual risk: the generated patch is still heuristic and not an LLM-produced code diff; it is intentionally a harness plan so the platform can evolve safely.

## Verification

- `mvn.cmd -DskipTests compile` in `backend` passed.
- `npm.cmd run build` in `app` passed with existing Vite chunk warnings.
