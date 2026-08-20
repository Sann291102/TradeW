# `docs/security/`

Security investigations and the evidence behind every public security claim
TradeW makes.

---

## The rule

> A security claim may be published only when someone can open the file that
> backs it. If the evidence moves, the claim moves in the same commit.

`SECURITY_CLAIMS_EVIDENCE.md` is where that rule is enforced. Read it before
writing any security sentence that will reach a user.

## Contents

| Document | Read it when |
| --- | --- |
| [`SECURITY_CLAIMS_EVIDENCE.md`](./SECURITY_CLAIMS_EVIDENCE.md) | **Start here.** Every published claim, its evidence, and every claim TradeW deliberately does not make. Also carries the `security.txt` decision and the contact/incident-response gap. |
| [`BROKER_CREDENTIAL_THREAT_MODEL.md`](./BROKER_CREDENTIAL_THREAT_MODEL.md) | You are touching broker credentials, or you want the 17-stage lifecycle trace and who can read what. |
| [`BROKER_CREDENTIAL_SECURITY_DESIGN.md`](./BROKER_CREDENTIAL_SECURITY_DESIGN.md) | You are changing the at-rest format, rotating a key, or running the backfill. |
| [`BROKER_CREDENTIAL_SECURITY_REMEDIATION_REPORT.md`](./BROKER_CREDENTIAL_SECURITY_REMEDIATION_REPORT.md) | You want the finding, what was done, what was tested, and what is still open. |

## The code these describe

```
packages/database/src/credential-crypto.ts        the at-rest format — the ONLY encrypt/decrypt
packages/database/src/credential-crypto.spec.ts   20 assertions on the format
packages/database/scripts/encrypt-broker-credentials.ts   the backfill (dry run by default)
services/api/src/broker/dhan-auth.service.ts      seal() / open() — the service boundary
services/api/src/broker/credential-storage.spec.ts        11 assertions on the service
services/api/src/common/security-log.ts           redaction, by key pattern and by value shape
services/market-data/scripts/live-feed-server.ts  the feed bridge's decryption boundary
```

## Open items, in priority order

Both are blocked on a person, not on engineering.

1. **No vulnerability disclosure channel.** No monitored security address, no
   `security.txt`, no public tracker. A researcher who finds a flaw has only a
   public option. One monitored address unblocks this, the DPDP grievance route,
   and the whole Company footer group at once.
2. **Run the credential backfill in each environment**, then require broker
   reconnection, then handle pre-remediation backups. Tooling is built and
   tested; the run is an operator action by design.

## Adding a document here

1. It records a real finding, a real design, or real evidence — not a plan to
   look into something.
2. It cites the file it is derived from.
3. It states what it does **not** cover. `BROKER_CREDENTIAL_SECURITY_DESIGN.md`
   §11 is the model: the honest limits of a control belong beside the control.
4. Any claim it makes public is added to `SECURITY_CLAIMS_EVIDENCE.md` §1 in the
   same commit.

## Related

- [`docs/footer/`](../footer/) — the footer, legal and trust surface. Its audit
  is where the plaintext-credential finding surfaced, and its
  `LEGAL_SURFACE_REQUIREMENTS.md` §7 raised the missing disclosure channel.
