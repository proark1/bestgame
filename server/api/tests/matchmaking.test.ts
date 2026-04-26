import { describe, expect, it } from 'vitest';
import { validateTargetDefenderId } from '../src/routes/matchmaking.js';

// validateTargetDefenderId is the small, testable rule that decides
// whether a /match POST body's targetDefenderId is honoured (revenge
// path) or dropped on the floor (fall through to random matchmaking).
// The DB-touching parts of /match — shield filter, base lookup,
// pending_matches insert — need an integration harness; these pure
// rules can be pinned cheaply.

describe('validateTargetDefenderId', () => {
  const attackerId = 'attacker-uuid';

  it('returns null for non-strings', () => {
    expect(validateTargetDefenderId(undefined, attackerId)).toBeNull();
    expect(validateTargetDefenderId(null, attackerId)).toBeNull();
    expect(validateTargetDefenderId(42, attackerId)).toBeNull();
    expect(validateTargetDefenderId({}, attackerId)).toBeNull();
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(validateTargetDefenderId('', attackerId)).toBeNull();
    expect(validateTargetDefenderId('   ', attackerId)).toBeNull();
  });

  it('rejects self-targeting', () => {
    expect(validateTargetDefenderId(attackerId, attackerId)).toBeNull();
  });

  it('returns the trimmed id when valid', () => {
    expect(validateTargetDefenderId('defender-uuid', attackerId)).toBe('defender-uuid');
    expect(validateTargetDefenderId('  defender-uuid  ', attackerId)).toBe('defender-uuid');
  });

  it('does not consider trimmed self-match valid', () => {
    expect(validateTargetDefenderId(`  ${attackerId}  `, attackerId)).toBeNull();
  });
});
