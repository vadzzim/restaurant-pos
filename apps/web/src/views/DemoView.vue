<script setup lang="ts">
import { computed } from 'vue';
import { type LocationQueryRaw, useRoute, useRouter } from 'vue-router';

import SimulatorPanel from '../components/SimulatorPanel.vue';
import StateBadge from '../components/StateBadge.vue';
import {
  CONTROL_LABELS,
  DEMO_SCENARIOS,
  controlAnchor,
  controlsUsed,
  formatDoneSteps,
  parseDoneSteps,
  progressLabel,
  renderInline,
  scenarioById,
  tabsUsed,
  type DemoScenario,
} from '../domain/demo-script';

/**
 * §19's ten scenarios, guided.
 *
 * The script itself is data in `domain/demo-script.ts` — this file is only the rendering of it, so
 * that "does every scenario name a control that exists" is a test rather than a walk-through.
 *
 * **One simulator panel, not two.** `/debug` already renders all eleven §18 controls and they are
 * the same module-level state, so this page embeds that component rather than growing a second set
 * of buttons that could drift from it. A step names a control and links to its row below.
 */

/** This page's own route. Named once: `linkTo` and the query writer both need it. */
const DEMO_PATH = '/demo';

const route = useRoute();
const router = useRouter();

/**
 * **The selection lives in the URL, not in a `ref`.**
 *
 * Half the scenarios send the operator to a till and back, and every one of those round trips
 * unmounts this component — so a local `ref` came back as §19.1 and the reader had to hunt for the
 * scenario they were three steps into. That is exactly the improvisation this page exists to
 * remove. In the query it survives the walk, the browser's Back button and a reload, and a link to
 * one scenario is something that can be handed to somebody.
 *
 * A query parameter rather than the hash, because the hash is already how a step jumps to a
 * control's row in the panel below.
 */
const selectedId = computed<string>({
  get: () => {
    const asked = route.query.scenario;
    // Anything unrecognised falls back rather than blanking the page: a hand-edited or stale URL
    // should open the demo, not an error.
    return typeof asked === 'string' && scenarioById(asked) !== undefined
      ? asked
      : DEMO_SCENARIOS[0]!.id;
  },
  set: (id: string) => {
    // The ticks are dropped, not carried: they belong to the scenario they were made on, and a
    // walk-through of a different one must not start half done.
    void router.replace({ path: DEMO_PATH, query: withoutDone({ scenario: id }) });
  },
});

const scenario = computed<DemoScenario>(() => scenarioById(selectedId.value) ?? DEMO_SCENARIOS[0]!);

/** This page's query minus the ticks, with `overrides` applied. Every writer below goes through it. */
function withoutDone(overrides: LocationQueryRaw): LocationQueryRaw {
  const next: LocationQueryRaw = { ...route.query, ...overrides };
  delete next.done;
  return next;
}

/** `{ done: '1,3' }`, or nothing at all — so an empty set leaves no `?done=` behind. */
function doneQuery(ticked: ReadonlySet<number>): LocationQueryRaw {
  const encoded = formatDoneSteps(ticked);
  return encoded === undefined ? {} : { done: encoded };
}

/**
 * Ticked steps — **in the URL, beside the scenario**, and for the same reasons (`?done=1,3,4`).
 *
 * They were a `ref` until M23, which meant a reload mid-demo lost the place: the one thing an
 * interviewer might actually do to this page while walking a scenario that tells them to reload a
 * till. The parsing and the formatting are in `domain/demo-script.ts`, where they are tested; this
 * is only the wiring, and switching scenario still clears them (see `selectedId`'s setter).
 */
const done = computed<Set<number>>(() =>
  parseDoneSteps(route.query.done, scenario.value.steps.length),
);

function toggle(index: number): void {
  const next = new Set(done.value);
  if (!next.delete(index)) {
    next.add(index);
  }
  // `replace`, so ticking eight steps does not put eight entries between the operator and Back.
  void router.replace({ path: DEMO_PATH, query: { ...withoutDone({}), ...doneQuery(next) } });
}

/**
 * Where a step's route link points. A step that says "come back here" has to carry the selection
 * with it, or it lands on §19.1 and undoes the whole point of the paragraph at the top.
 */
const linkTo = (path: string): string | { path: string; query: LocationQueryRaw } =>
  path === DEMO_PATH
    ? // The ticks travel with it, or a step saying "come back here" would undo the paragraph below.
      { path, query: { ...withoutDone({ scenario: selectedId.value }), ...doneQuery(done.value) } }
    : path;

const controls = computed(() => controlsUsed(scenario.value));
const tabs = computed(() => tabsUsed(scenario.value));
const progress = computed(() => progressLabel(done.value, scenario.value.steps.length));
</script>

<template>
  <!--
    eslint-disable vue/no-v-html --
    Every `v-html` below renders `renderInline`, which HTML-escapes its input before putting back
    the two constructs the script uses (`**bold**` and ``code``). The input is a constant in
    `domain/demo-script.ts`; the escaping is what makes that a fact about the renderer rather than
    a fact about today's strings, and `demo-script.test.ts` holds it.
  -->
  <section class="space-y-6">
    <header>
      <h1 class="text-3xl font-semibold">Guided demo</h1>
      <p class="mt-2 max-w-3xl text-stone-700">
        The ten scenarios of §19, in order, with what to press and what to watch while pressing it.
        Every §18 control the steps name is in the panel at the foot of this page — the same
        controls <RouterLink class="underline" to="/debug">/debug</RouterLink> renders, because they
        are the same state.
      </p>
      <p class="mt-2 max-w-3xl text-sm text-stone-600">
        Two things worth knowing before the first click. The three mutation one-shots and the two
        transport latches live in <strong>this browser tab</strong> (ADR 015): arming one here and
        then walking to a till works, a second tab or a reload does not. And a till keeps its order
        while you walk away — the pointer is on disk — which is what lets an arm pressed here be
        spent on an item rather than always on the order's own creation.
      </p>
    </header>

    <!-- The picker. Ten scenarios is few enough to show them all, and an interviewer asking for
         "the outbox one" should not have to open a select. -->
    <nav class="flex flex-wrap gap-2" aria-label="Scenarios">
      <button
        v-for="option in DEMO_SCENARIOS"
        :key="option.id"
        type="button"
        class="rounded-lg border px-3 py-2 text-left text-sm font-semibold"
        :class="
          option.id === selectedId
            ? 'border-emerald-800 bg-emerald-700 text-white'
            : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
        "
        :aria-current="option.id === selectedId ? 'true' : undefined"
        @click="selectedId = option.id"
      >
        <span class="block text-xs font-normal opacity-70">{{ option.spec }}</span>
        {{ option.title }}
      </button>
    </nav>

    <article class="rounded-xl border border-stone-300 bg-white p-5">
      <header class="border-b border-stone-200 pb-4">
        <div class="flex flex-wrap items-baseline gap-3">
          <h2 class="text-2xl font-semibold">{{ scenario.title }}</h2>
          <StateBadge :label="scenario.spec" tone="neutral" />
          <span class="ml-auto text-sm text-stone-600 tabular-nums">{{ progress }} steps</span>
        </div>
        <p class="mt-2 max-w-3xl text-stone-800" v-html="renderInline(scenario.claim)"></p>

        <dl class="mt-4 grid gap-3 text-sm md:grid-cols-2">
          <div class="rounded border border-stone-200 bg-stone-50 p-3">
            <dt class="mb-1 font-semibold">Before you start</dt>
            <dd class="text-stone-700" v-html="renderInline(scenario.needs)"></dd>
            <dd v-if="tabs.length > 1" class="mt-2 text-stone-700">
              Windows used: {{ tabs.join(', ') }}.
            </dd>
          </div>
          <div class="rounded border border-stone-200 bg-stone-50 p-3">
            <dt class="mb-1 font-semibold">Controls it uses</dt>
            <dd v-if="controls.length === 0" class="text-stone-700">
              None — this one is the application on its own.
            </dd>
            <dd v-else class="flex flex-wrap gap-2">
              <a
                v-for="control in controls"
                :key="control"
                :href="`#${controlAnchor(control)}`"
                class="rounded border border-emerald-700 px-2 py-1 font-medium text-emerald-900 hover:bg-emerald-50"
              >
                {{ CONTROL_LABELS[control] }} ↓
              </a>
            </dd>
          </div>
        </dl>
      </header>

      <ol class="mt-4 space-y-3">
        <li
          v-for="(step, index) in scenario.steps"
          :key="index"
          class="rounded-lg border p-3"
          :class="done.has(index) ? 'border-emerald-300 bg-emerald-50/60' : 'border-stone-200'"
        >
          <div class="flex items-start gap-3">
            <input
              :id="`step-${scenario.id}-${index}`"
              type="checkbox"
              class="mt-1 size-5 shrink-0"
              :checked="done.has(index)"
              @change="toggle(index)"
            />
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex flex-wrap items-center gap-2">
                <span class="text-sm font-bold text-stone-500 tabular-nums">{{ index + 1 }}</span>
                <StateBadge v-if="step.tab" :label="`window ${step.tab}`" tone="neutral" />
                <RouterLink
                  v-if="step.route"
                  :to="linkTo(step.route)"
                  class="rounded bg-stone-800 px-2 py-0.5 text-xs font-semibold text-white"
                >
                  {{ step.route }}
                </RouterLink>
                <a
                  v-if="step.control"
                  :href="`#${controlAnchor(step.control)}`"
                  class="rounded border border-emerald-700 px-2 py-0.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-50"
                >
                  {{ CONTROL_LABELS[step.control] }} ↓
                </a>
              </div>

              <label
                :for="`step-${scenario.id}-${index}`"
                class="block text-base text-stone-900"
                v-html="renderInline(step.do)"
              ></label>

              <pre
                v-if="step.command"
                class="mt-2 overflow-x-auto rounded bg-stone-900 px-3 py-2 text-sm text-stone-100"
              ><code>{{ step.command }}</code></pre>

              <p
                v-if="step.watch"
                class="mt-2 border-l-4 border-amber-400 pl-3 text-sm text-stone-700"
                v-html="`<strong>Watch:</strong> ${renderInline(step.watch)}`"
              ></p>
            </div>
          </div>
        </li>
      </ol>
    </article>

    <SimulatorPanel />
  </section>
</template>
