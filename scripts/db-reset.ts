/**
 * `bun db:reset`: drops and re-migrates one of this checkout's own slot
 * databases (ADR 0034), then provisions the test logins again (ISSUE-6).
 * Production, a non-loopback host or a missing ALLOW_DATABASE_RESET=yes is
 * refused before a connection opens. The slot is then decided from the
 * ownership records under the slot lock, exactly as `bun slot:up` decides
 * it, so a standalone clone whose .env still names the main checkout's
 * databases is refused rather than resetting them.
 */
import { SQL } from 'bun';
import { resolve } from 'node:path';
import {
  provisionTestRoles,
  resetPublicSchema,
  withSlotLock,
} from '@acme/db/slots';
import { e2eRole, resetEnvRefusal, resetRefusal } from './slot-model';
import { locateCheckout, migrate, resolveCheckout } from './slot-services';

const root = resolve(import.meta.dir, '..');
const envRefusal = resetEnvRefusal(process.env);
if (envRefusal) throw new Error(envRefusal);
const location = await locateCheckout(root);
const url = process.env.DATABASE_URL ?? '';
// Re-running the baseline touches cluster-wide roles, so reset takes the
// same slot lock as slot:up. Advisory locks are per database: every holder
// takes it from the `postgres` database, never the slot's own.
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = new SQL(adminUrl.toString(), { max: 1 });
let client: SQL | undefined;
try {
  await withSlotLock(admin, async () => {
    const { slot } = await resolveCheckout(admin, location);
    const refusal = resetRefusal(slot, process.env);
    if (refusal) throw new Error(refusal);
    client = new SQL(url, { max: 1 });
    await resetPublicSchema(client);
    await migrate(url, location.path);
    await provisionTestRoles(admin, e2eRole);
  });
} finally {
  await client?.close();
  await admin.close();
}
