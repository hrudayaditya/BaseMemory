import { describe, expect, it } from 'vitest';

import { clearCinematicFocus, cinematicFocusRequest, requestCinematicFocus } from '../src/hyperbase/src/stores/ui';
import { withAlpha } from '../src/hyperbase/src/lib/theme';

function readStore<T>(store: { subscribe: (run: (value: T) => void) => () => void }): T {
  let current!: T;
  const unsubscribe = store.subscribe((value) => {
    current = value;
  });
  unsubscribe();
  return current;
}

describe('demo UX helpers', () => {
  it('stores and clears cinematic focus requests', () => {
    requestCinematicFocus('sym_demo', 'search', 0.72);
    expect(readStore(cinematicFocusRequest)).toEqual({
      nodeId: 'sym_demo',
      reason: 'search',
      ratio: 0.72,
    });

    clearCinematicFocus();
    expect(readStore(cinematicFocusRequest)).toBeNull();
  });

  it('converts theme colors to translucent rgba values', () => {
    expect(withAlpha('#4f9cf9', 0.25)).toBe('rgba(79, 156, 249, 0.25)');
    expect(withAlpha('rgba(255, 255, 255, 0.9)', 0.4)).toBe('rgba(255, 255, 255, 0.4)');
  });
});
