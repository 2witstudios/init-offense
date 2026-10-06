/**
 * Who owns a slot (ADR 0034), split from slot-model.ts. Git structure alone
 * cannot tell the main checkout from a standalone clone of the same
 * repository elsewhere on the machine: both are their repository's main
 * worktree. So every slot records the absolute path of the checkout that
 * claimed it in its dev database's comment, beside a worktree's port block,
 * and this module decides from those records:
 *
 * - which slot a checkout gets: the main slot only when it is the recorded
 *   main checkout (or the first to claim it); any other standalone clone
 *   gets a clone slot keyed by a hash of its path;
 * - whether a command may touch a slot: never one recorded for another
 *   checkout that still exists on disk;
 * - which slots a prune drops: only those whose recorded checkout no longer
 *   exists, never a live checkout's slot that this checkout does not know.
 *
 * Pure: whether a path exists is injected as `isLive`.
 */
import { createHash } from 'node:crypto';
import {
  deriveSlot,
  idOfDatabase,
  idOfNamespace,
  worktreeSlot,
  type Slot,
} from './slot-model';
import { slotNaming } from './slot-naming';
import { isPortBlock } from './slot-ports';

const { databaseBase, worktreeDatabasePrefix, maxIdLength } =
  slotNaming('acme');

type IsLive = (path: string) => boolean;

export type SlotClaim = {
  readonly portBlock?: number | undefined;
  readonly checkout?: string | undefined;
};

// The checkout path is hex-encoded so the comment stays inside the strict
// literal allowlist of @acme/db/slots (no quotes, slashes or case).
const claimPattern =
  /^acme-slot(?: port-block=([1-9][0-9]{0,2}))?(?: checkout=((?:[0-9a-f]{2})+))?$/;

/** The claim stored as a slot dev database's comment (shared, self-cleaning). */
export function slotClaimComment({ portBlock, checkout }: SlotClaim): string {
  if (portBlock !== undefined && !isPortBlock(portBlock))
    throw new Error(`Invalid port block ${portBlock}`);
  if (checkout === '') throw new Error('A slot claim needs a checkout path');
  return [
    'acme-slot',
    ...(portBlock === undefined ? [] : [`port-block=${portBlock}`]),
    ...(checkout === undefined
      ? []
      : [`checkout=${Buffer.from(checkout, 'utf8').toString('hex')}`]),
  ].join(' ');
}

export function parseSlotClaim(comment: string | null | undefined): SlotClaim {
  const match = claimPattern.exec(comment ?? '');
  if (!match) return {};
  const portBlock = match[1] === undefined ? undefined : Number(match[1]);
  return {
    ...(portBlock !== undefined && isPortBlock(portBlock) ? { portBlock } : {}),
    ...(match[2] === undefined
      ? {}
      : { checkout: Buffer.from(match[2], 'hex').toString('utf8') }),
  };
}

/**
 * A standalone clone's slot id: a stable hash of its absolute path, so the
 * same clone keeps its slot and a moved clone gets a new one (its old slot's
 * recorded path is gone, so the next prune drops it).
 */
export function cloneSlotId(checkout: string, budget = maxIdLength): string {
  const prefix = budget >= 'clone_'.length + 8 ? 'clone_' : 'c';
  const hex = createHash('sha3-256').update(checkout).digest('hex');
  return `${prefix}${hex.slice(0, Math.min(8, budget - prefix.length))}`;
}

/** What the main database records: missing, unrecorded (legacy), or a path. */
export type MainRecord =
  | { readonly state: 'absent' }
  | { readonly state: 'unrecorded' }
  | { readonly state: 'recorded'; readonly checkout: string };

export function mainRecordOf(
  databases: readonly {
    readonly name: string;
    readonly comment: string | null;
  }[],
): MainRecord {
  const main = databases.find(({ name }) => name === databaseBase);
  if (!main) return { state: 'absent' };
  const { checkout } = parseSlotClaim(main.comment);
  return checkout === undefined
    ? { state: 'unrecorded' }
    : { state: 'recorded', checkout };
}

const claimHint =
  'If this is the main checkout, run `bun slot:up --claim-main` once; a scratch clone must wait until the main checkout has claimed its slot';

/**
 * The slot of a checkout and whether it (re)claims the main slot. Throws a
 * refusal instead of guessing whenever the main slot's owner is unknown.
 */
export function classifyCheckout({
  checkout,
  gitMain,
  main,
  isLive,
  claimMain = false,
}: {
  readonly checkout: string;
  /** The repository's main worktree (`git worktree list`, first entry). */
  readonly gitMain: string;
  readonly main: MainRecord;
  readonly isLive: IsLive;
  readonly claimMain?: boolean;
}): { readonly slot: Slot; readonly claimsMain: boolean } {
  const structural = deriveSlot({ checkout, mainCheckout: gitMain });
  if (structural.kind === 'worktree') {
    if (claimMain)
      throw new Error(
        'Only a repository main checkout can claim the main slot, not a git worktree',
      );
    return { slot: structural, claimsMain: false };
  }
  if (main.state === 'recorded' && main.checkout === checkout)
    return { slot: structural, claimsMain: false };
  if (main.state === 'absent') return { slot: structural, claimsMain: true };
  if (main.state === 'recorded' && isLive(main.checkout)) {
    if (claimMain)
      throw new Error(
        `The main slot belongs to the live checkout at ${main.checkout}; --claim-main never takes it from a checkout that exists`,
      );
    return { slot: worktreeSlot(cloneSlotId(checkout)), claimsMain: false };
  }
  if (claimMain) return { slot: structural, claimsMain: true };
  throw new Error(
    main.state === 'unrecorded'
      ? `The main slot ${databaseBase} records no owner (it predates ownership records). ${claimHint}.`
      : `The main slot ${databaseBase} was claimed by ${main.checkout}, which no longer exists. ${claimHint}.`,
  );
}

/** Why this checkout must not touch its derived slot, or undefined. */
export function ownershipRefusal({
  slot,
  checkout,
  recorded,
  isLive,
}: {
  readonly slot: Slot;
  readonly checkout: string;
  readonly recorded: string | undefined;
  readonly isLive: IsLive;
}): string | undefined {
  if (recorded === undefined || recorded === checkout || !isLive(recorded))
    return undefined;
  return `Slot ${slot.id} belongs to the live checkout at ${recorded}, not ${checkout}: rename this folder so it derives a slot of its own`;
}

/** The checkout recorded on a slot's dev database, if any. */
export function recordedOwner(
  databases: readonly {
    readonly name: string;
    readonly comment: string | null;
  }[],
  database: string,
): string | undefined {
  return parseSlotClaim(
    databases.find(({ name }) => name === database)?.comment,
  ).checkout;
}

/**
 * Slots to drop. A slot whose dev database records a checkout is an orphan
 * only when that path no longer exists. A slot with no record (one claimed
 * before records existed, or keys whose database is gone) is an orphan only
 * when `legacyLiveIds` is given, which the caller does only for checkouts of
 * the main slot's own repository, whose `git worktree list` is authoritative,
 * and the id is not among them. This checkout's own slot is never selected,
 * and names that do not parse as a worktree slot are never touched.
 */
export function findOrphans({
  ownId,
  databases,
  namespaces,
  isLive,
  legacyLiveIds,
}: {
  readonly ownId?: string | undefined;
  readonly databases: readonly {
    readonly name: string;
    readonly comment: string | null;
  }[];
  readonly namespaces: readonly string[];
  readonly isLive: IsLive;
  readonly legacyLiveIds?: readonly string[] | undefined;
}) {
  const legacyLive =
    legacyLiveIds === undefined ? undefined : new Set(legacyLiveIds);
  const orphaned = (id: string | undefined): id is string => {
    if (id === undefined || id === ownId) return false;
    const owner = recordedOwner(databases, `${worktreeDatabasePrefix}${id}`);
    if (owner !== undefined) return !isLive(owner);
    return legacyLive !== undefined && !legacyLive.has(id);
  };
  const orphanDatabases = databases
    .map(({ name }) => name)
    .filter((name) => orphaned(idOfDatabase(name)));
  const orphanNamespaces = namespaces.filter((name) =>
    orphaned(idOfNamespace(name)),
  );
  const ids = new Set([
    ...orphanDatabases.map(idOfDatabase),
    ...orphanNamespaces.map(idOfNamespace),
  ]);
  return {
    ids: [...ids].filter((id): id is string => id !== undefined).sort(),
    databases: [...orphanDatabases].sort(),
    namespaces: [...orphanNamespaces].sort(),
  };
}
