---
type: gotcha
date: 2026-08-12
tags: [gotcha, nestjs, api, typescript, decorators]
---

# A DTO declared below its controller kills the API at boot

**Symptom.** `services/api` compiles with 0 errors, all 281 tests pass, and the
process dies immediately on start:

```
ReferenceError: Cannot access 'SetPerceptorEnabledDto' before initialization
    at Object.<anonymous> (src/admin/admin.controller.ts:314:62)
    at Object.<anonymous> (src/admin/admin.module.ts:2:1)
```

**Cause.** `emitDecoratorMetadata` is on. TypeScript emits a `design:paramtypes`
entry naming each handler parameter's class, and that metadata is evaluated when
the **controller class is defined** — i.e. at module import time, not when the
route is called. `class` declarations are not hoisted out of their temporal dead
zone, so a DTO declared further down the same file does not exist yet.

`SetAdminDto` had always sat above `AdminController`, so the pattern was
correct-by-accident until three new DTOs were appended to the bottom of the file
during the cognition work.

**Rule.** In any Nest controller, **every DTO used in a `@Body()` / `@Query()` /
`@Param()` signature must be declared above the controller class**, or imported
from another module. There is now a comment saying so above `SetAdminDto` in
`services/api/src/admin/admin.controller.ts`.

**Why nothing caught it.** This is the part worth remembering:

- `tsc --noEmit` passes. TDZ is a runtime property; TypeScript resolves the type
  reference statically and is satisfied.
- `vitest` passes. No unit test instantiates the Nest application context, so no
  test ever imports `admin.module.ts`.
- The only thing that catches it is **starting the service**.

Any change that adds a decorated class to an existing Nest file should be
followed by an actual boot, not just a typecheck and a test run.

## The second failure the same boot exposed

Fixing the TDZ error revealed a different one immediately behind it:

```
Nest can't resolve dependencies of the AdminService (PrismaService, ?).
Please make sure that the argument CognitionService at index [1] is available
in the ControlModule context.
```

`AdminService` is provided **twice**: by `AdminModule`, and directly by
`ControlModule` — deliberately, so the console's no-exports boundary survives
(see the comment in `control.module.ts`). That arrangement only works while
`AdminService`'s constructor needs nothing but the `@Global` `PrismaService`.
Injecting `CognitionService` into it took down the control plane at boot, in a
module that has nothing to do with cognition.

**Rule.** `AdminService` takes `PrismaService` and nothing else. Anything that
needs live in-memory state goes on `AdminController`, which is only ever
instantiated inside `AdminModule` and can inject whatever that module imports.
Both files now carry a note saying so.

Related: [[Decisions/2026-08-12 - Cognition network (perceptors + four layers)]].
