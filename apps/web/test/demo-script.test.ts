import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTROL_LABELS,
  DEMO_CONTROLS,
  DEMO_SCENARIOS,
  controlAnchor,
  controlsUsed,
  offlineControlFor,
  progressLabel,
  renderInline,
  scenarioById,
  tabsUsed,
} from '../src/domain/demo-script';
import { coversFor } from '../src/domain/pos-screen';

/**
 * M16's verification bar is "each scenario can be performed by following the instructions, with no
 * improvisation". Most of that is prose and only a person can judge it — but three ways of failing
 * it are mechanical, and those are what this file holds the line on:
 *
 * - a scenario for a §19 clause is missing, so the walk-through is incomplete;
 * - a step tells the reader to press a control the panel does not render;
 * - a step links to a route the router does not have.
 *
 * The last two read the real `SimulatorPanel.vue` and `router.ts` rather than a copy of what they
 * are believed to contain. A test that asserted against a second list would go green on exactly the
 * drift it exists to catch.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const PANEL = read('../src/components/SimulatorPanel.vue');
const ROUTER = read('../src/router.ts');

/** `/pos/:terminalId` matches `/pos/pos-1`; everything else is a literal. */
const routePatterns = (): RegExp[] =>
  [...ROUTER.matchAll(/path: '([^']+)'/g)].map(
    (match) => new RegExp(`^${match[1]!.replace(/:[^/]+/g, '[^/]+')}$`),
  );

describe('the §19 script', () => {
  it('covers all ten scenarios, in the order the spec numbers them', () => {
    expect(DEMO_SCENARIOS.map((scenario) => scenario.spec)).toEqual([
      '§19.1',
      '§19.2',
      '§19.3',
      '§19.4',
      '§19.5',
      '§19.6',
      '§19.7',
      '§19.8',
      '§19.9',
      '§19.10',
    ]);
  });

  it('gives every scenario an id, a claim, preconditions and steps', () => {
    const ids = new Set<string>();

    for (const scenario of DEMO_SCENARIOS) {
      expect(scenario.id, scenario.spec).toMatch(/^[a-z][a-z-]*$/);
      expect(ids.has(scenario.id), `${scenario.id} is used twice`).toBe(false);
      ids.add(scenario.id);

      expect(scenario.title.length, scenario.spec).toBeGreaterThan(0);
      expect(scenario.claim.length, scenario.spec).toBeGreaterThan(40);
      expect(scenario.needs.length, scenario.spec).toBeGreaterThan(20);
      expect(scenario.steps.length, scenario.spec).toBeGreaterThan(1);

      for (const step of scenario.steps) {
        expect(step.do.length, `${scenario.spec}: ${step.do}`).toBeGreaterThan(0);
      }
    }
  });

  it('finds a scenario by id, and nothing by a name that is not one', () => {
    expect(scenarioById('outbox-failure')?.spec).toBe('§19.7');
    expect(scenarioById('no-such-scenario')).toBeUndefined();
  });

  it('starts the first step of every scenario somewhere, so the reader knows where to be', () => {
    for (const scenario of DEMO_SCENARIOS) {
      const first = scenario.steps[0]!;
      // §19.10 is a command, not a screen — it is the one scenario with nowhere to navigate.
      const situated = first.route !== undefined || first.command !== undefined;
      expect(situated, scenario.spec).toBe(true);
    }
  });
});

/**
 * Whether the panel stamps an anchor for this control. The two offline gates are one `v-for` row
 * over the terminal list, so they are matched through the expression that builds their id rather
 * than through a literal — otherwise this only passes while the markup is written one way.
 */
const panelRenders = (control: string): boolean =>
  PANEL.includes(`controlAnchor('${control}')`) ||
  ((control === 'offline-pos-1' || control === 'offline-pos-2') &&
    PANEL.includes('controlAnchor(offlineControlFor(terminal))'));

describe('what a step points at', () => {
  it('only names controls the simulator panel actually renders', () => {
    for (const scenario of DEMO_SCENARIOS) {
      for (const control of controlsUsed(scenario)) {
        expect(DEMO_CONTROLS, scenario.spec).toContain(control);
        expect(panelRenders(control), `${scenario.spec} links to ${control}`).toBe(true);
      }
    }
  });

  it('gives every one of the eleven controls an anchor on the panel', () => {
    for (const control of DEMO_CONTROLS) {
      expect(panelRenders(control), `${control} has no row on the panel`).toBe(true);
      expect(CONTROL_LABELS[control].length, control).toBeGreaterThan(0);
    }

    expect(DEMO_CONTROLS).toHaveLength(11);
  });

  it('resolves the offline gate of each terminal to its own control', () => {
    expect(offlineControlFor('pos-1')).toBe('offline-pos-1');
    expect(offlineControlFor('pos-2')).toBe('offline-pos-2');
  });

  it('only links to routes the router has', () => {
    const patterns = routePatterns();
    expect(patterns.length).toBeGreaterThan(3);

    for (const scenario of DEMO_SCENARIOS) {
      for (const step of scenario.steps) {
        if (step.route === undefined) {
          continue;
        }
        const matched = patterns.some((pattern) => pattern.test(step.route!));
        expect(matched, `${scenario.spec} links to ${step.route}`).toBe(true);
      }
    }
  });

  it('only names covers the dining pad actually offers', () => {
    // `coversFor('dining')` is the pad. A step naming a table that is not on it sends the reader to
    // the free-text field to improvise, which is the one thing this milestone is judged on — and
    // the first browser walk of M16 found exactly that, twice.
    const pad = new Set(coversFor('dining'));

    for (const scenario of DEMO_SCENARIOS) {
      for (const step of scenario.steps) {
        for (const match of step.do.matchAll(/\*\*Table (\w+)\*\*/g)) {
          expect(pad.has(match[1]!), `${scenario.spec} names Table ${match[1]}`).toBe(true);
        }
      }
    }
  });

  it('uses no markup renderInline would leave on the page as literal asterisks', () => {
    // `renderInline` knows `**bold**` and backticks and nothing else, so a single-asterisk span
    // reaches the reader as asterisks. The first browser walk shipped three of them.
    const stray = /(?<!\*)\*(?!\*)[^*\n]+\*(?!\*)/;

    for (const scenario of DEMO_SCENARIOS) {
      for (const text of [scenario.needs, scenario.claim]) {
        expect(stray.test(text), `${scenario.spec}: ${text}`).toBe(false);
      }
      for (const step of scenario.steps) {
        for (const text of [step.do, step.watch ?? '']) {
          expect(stray.test(text), `${scenario.spec}: ${text}`).toBe(false);
        }
      }
    }
  });

  it('anchors a control at the id the panel stamps on it', () => {
    expect(controlAnchor('outbox-pause')).toBe('sim-outbox-pause');
  });
});

describe('the helpers the page renders through', () => {
  it('lists the controls a scenario uses once each, in step order', () => {
    // §19.7 presses the same switch twice — pause at the start, resume at the end.
    expect(controlsUsed(scenarioById('outbox-failure')!)).toEqual(['outbox-pause']);
    expect(controlsUsed(scenarioById('normal-flow')!)).toEqual([]);
  });

  it('lists the windows a scenario needs', () => {
    expect(tabsUsed(scenarioById('normal-flow')!)).toEqual(['A', 'B']);
    expect(tabsUsed(scenarioById('duplicate-mutation')!)).toEqual(['A']);
    expect(tabsUsed(scenarioById('multi-instance')!)).toEqual([]);
  });

  it('counts ticked steps, ignoring ticks outside the scenario', () => {
    expect(progressLabel(new Set([0, 1]), 5)).toBe('2 of 5');
    expect(progressLabel(new Set([0, 9]), 5)).toBe('1 of 5');
    expect(progressLabel(new Set(), 5)).toBe('0 of 5');
  });
});

describe('renderInline', () => {
  it('turns the two constructs the script uses into markup', () => {
    expect(renderInline('press **Pay card**')).toBe('press <strong>Pay card</strong>');
    expect(renderInline('at `v2` or higher')).toBe('at <code>v2</code> or higher');
  });

  it('escapes first, so nothing in a string can become markup of its own', () => {
    expect(renderInline('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(renderInline('**<b>x</b>**')).toBe('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    expect(renderInline('a & b')).toBe('a &amp; b');
    expect(renderInline('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('leaves an unpaired marker alone rather than opening a tag', () => {
    expect(renderInline('2 ** 8 and a stray `')).toBe('2 ** 8 and a stray `');
  });
});
