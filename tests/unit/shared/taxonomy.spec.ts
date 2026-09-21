// tests/unit/shared/taxonomy.spec.ts
//
// Keeps the three descriptions of the event taxonomy from drifting apart:
//   docs/event-taxonomy.yaml   (documentation, spec Day 1)
//   src/events/taxonomy.yaml   (in-repo copy at the path the spec's tree requires)
//   src/shared/constants/event-types.ts (what the code actually uses)
import { readFileSync } from 'fs';
import {
  CRITICAL_EVENTS,
  EVENT_TYPES,
  REGULATORY_MANDATORY_EVENTS,
} from '../../../src/shared/constants/event-types';

const docs = readFileSync('docs/event-taxonomy.yaml', 'utf8');
const src = readFileSync('src/events/taxonomy.yaml', 'utf8');

const codes = (yaml: string) =>
  [...yaml.matchAll(/^\s{6}((?:TXNX|RISK|SIPX|MKTX|REGX)-\d{3}):/gm)].map(
    (m) => m[1],
  );
const urgencies = (yaml: string): Record<string, string> =>
  Object.fromEntries(
    [
      ...yaml.matchAll(
        /((?:TXNX|RISK|SIPX|MKTX|REGX)-\d{3}):\s*\{[^}]*?urgency:\s*(\w+)/gs,
      ),
    ].map((m) => [m[1], m[2]]),
  );

describe('event taxonomy', () => {
  it('src/events/taxonomy.yaml is identical to docs/event-taxonomy.yaml', () => {
    expect(src).toBe(docs);
  });

  it('defines exactly the 25 event types the code knows, no more and no fewer', () => {
    expect(new Set(codes(docs))).toEqual(new Set(Object.values(EVENT_TYPES)));
    expect(codes(docs)).toHaveLength(25);
  });

  it('covers all five categories with five events each', () => {
    for (const cat of ['TXNX', 'RISK', 'SIPX', 'MKTX', 'REGX']) {
      expect(codes(docs).filter((c) => c.startsWith(cat))).toHaveLength(5);
    }
  });

  it('every CRITICAL event in code is CRITICAL in the taxonomy (and vice versa)', () => {
    const critical = Object.entries(urgencies(docs))
      .filter(([, u]) => u === 'CRITICAL')
      .map(([c]) => c);
    expect(new Set(critical)).toEqual(new Set(CRITICAL_EVENTS));
  });

  it('regulator-mandated events are all real event types', () => {
    const all = new Set<string>(Object.values(EVENT_TYPES));
    for (const e of REGULATORY_MANDATORY_EVENTS) expect(all.has(e)).toBe(true);
  });
});
