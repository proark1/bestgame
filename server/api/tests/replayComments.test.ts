import { describe, expect, it } from 'vitest';
import { validateCommentContent } from '../src/routes/replayFeed.js';

// validateCommentContent owns the small testable rules for replay
// comments — length cap, control-char strip, whitespace normalization.
// The DB-touching parts of the route (rate-limit, raid-existence
// check) need integration tests; these pure rules can be pinned cheap.

describe('validateCommentContent', () => {
  it('accepts a normal comment', () => {
    expect(validateCommentContent('nice play 🐜')).toEqual({ content: 'nice play 🐜' });
  });

  it('strips ASCII control characters', () => {
    const result = validateCommentContent('hi\x00\x07\x1ftext');
    expect(result).toEqual({ content: 'hitext' });
  });

  it('collapses whitespace runs', () => {
    expect(validateCommentContent('foo   \t\nbar')).toEqual({ content: 'foo bar' });
  });

  it('trims leading/trailing whitespace', () => {
    expect(validateCommentContent('   foo   ')).toEqual({ content: 'foo' });
  });

  it('rejects non-string input', () => {
    expect(validateCommentContent(undefined)).toEqual({ error: 'content required' });
    expect(validateCommentContent(42)).toEqual({ error: 'content required' });
    expect(validateCommentContent(null)).toEqual({ error: 'content required' });
  });

  it('rejects empty content (after sanitisation)', () => {
    expect(validateCommentContent('')).toEqual({ error: 'content cannot be empty' });
    expect(validateCommentContent('   ')).toEqual({ error: 'content cannot be empty' });
    expect(validateCommentContent('\x00\x01')).toEqual({ error: 'content cannot be empty' });
  });

  it('clamps overlong content to 280 chars', () => {
    const long = 'x'.repeat(500);
    const result = validateCommentContent(long);
    expect('content' in result).toBe(true);
    if ('content' in result) {
      expect(result.content.length).toBe(280);
    }
  });
});
