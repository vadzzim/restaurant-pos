/**
 * §19's ten scenarios, as data.
 *
 * It sits beside `pos-screen.ts` and `debug-view.ts` for the reason those do: a script that only
 * exists inside a template is a script no test can check, and the one thing `/demo` must never do
 * is tell an interviewer to press a button that is not there. The test over this file asserts that
 * every §19 clause has a scenario and that every control a step names is one the panel renders.
 *
 * **Two facts about this application shape almost every step here, and the page says both out loud
 * rather than working around them silently:**
 *
 * 1. The three mutation one-shots and the two latches live in *this browser tab* (ADR 015). Arming
 *    one on `/demo` and then walking to a POS screen is the intended flow and works; opening the
 *    POS in a second tab does not, and neither does a reload.
 * 2. Leaving a POS screen used to drop the order it was showing. M16 made that a detach rather than
 *    a clear — the pointer survives on disk — precisely so that an arm pressed here can be spent on
 *    an *item*, instead of always on the `CREATE_ORDER` a fresh till has to start with.
 */

/**
 * Every §18 control, by id: the four server switches, the two M8 offline gates, the three one-shots
 * and the two latches. Eleven, the number §18 asks for.
 *
 * The ids are the anchor targets on `/demo`, so a step links to the control it names instead of
 * leaving the reader to hunt the panel for it.
 */
export const DEMO_CONTROLS = [
  'outbox-pause',
  'outbox-delay',
  'printer-fail',
  'replay-last-event',
  'offline-pos-1',
  'offline-pos-2',
  'duplicate-next-mutation',
  'reuse-mutation-id',
  'create-version-conflict',
  'socket-disabled',
  'polling-forced',
] as const;

export type DemoControl = (typeof DEMO_CONTROLS)[number];

/**
 * The canonical name of each control, used by the panel's buttons *and* by the prose here. One
 * source, because a step reading "press Pause Publisher" beside a button reading "Pause Outbox
 * Publisher" is the exact failure this milestone is judged on.
 */
export const CONTROL_LABELS: Record<DemoControl, string> = {
  'outbox-pause': 'Pause Outbox Publisher',
  'outbox-delay': 'Delay Outbox Publishing',
  'printer-fail': 'Fail Printer',
  'replay-last-event': 'Replay Last Kafka Event',
  'offline-pos-1': 'Simulate POS-1 Offline',
  'offline-pos-2': 'Simulate POS-2 Offline',
  'duplicate-next-mutation': 'Duplicate Next Mutation',
  'reuse-mutation-id': 'Reuse Mutation Id With New Payload',
  'create-version-conflict': 'Create Version Conflict',
  'socket-disabled': 'Disconnect WebSocket',
  'polling-forced': 'Force Polling Transport',
};

/** Where a control sits on the page. `SimulatorPanel` stamps the same id on the control's row. */
export const controlAnchor = (control: DemoControl): string => `sim-${control}`;

/** The offline gate belonging to a terminal, so the panel's loop and the script agree on the id. */
export const offlineControlFor = (terminalId: string): DemoControl =>
  terminalId === 'pos-2' ? 'offline-pos-2' : 'offline-pos-1';

/** One instruction. `do` is always an imperative; everything else is optional context. */
export interface DemoStep {
  /** What to press, in the words the screen itself uses. */
  do: string;
  /** What moves when the step lands. Absent only when the step is pure navigation. */
  watch?: string;
  /** A §18 control this step presses. The page links it to the panel below. */
  control?: DemoControl;
  /** The route the step happens on, when it differs from the step before it. */
  route?: string;
  /** Which window, for the scenarios that genuinely need two. */
  tab?: string;
  /** A shell command, for the two places where the affordance is a CLI and not a button. */
  command?: string;
}

export interface DemoScenario {
  /** Slug, and the value `/demo` selects on. */
  id: string;
  /** The clause of §19 this is. */
  spec: string;
  title: string;
  /** What it proves — the sentence to say out loud before pressing anything. */
  claim: string;
  /** Preconditions: windows, terminals, and anything that has to be off before starting. */
  needs: string;
  steps: DemoStep[];
}

/** A note that recurs often enough to be worth writing once. */
const ARM_WALK =
  'Walk to POS-1 in **this** window — the arm lives in the tab, not on the server, so the ' +
  'navigation keeps it. A second tab or a reload would not.';

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'normal-flow',
    spec: '§19.1',
    title: 'Normal flow',
    claim:
      'One order from the first tap to payment, across a till and a kitchen display. The nine ' +
      'scenarios after this one are this one going wrong on purpose.',
    needs:
      'Two windows: POS-1 in window A, the kitchen in window B. The kitchen has to be beside the ' +
      'till rather than after it — half the point is the till following the kitchen live. Nothing ' +
      'armed: if a control below reads armed or paused, put it back first.',
    steps: [
      {
        tab: 'A',
        route: '/pos/pos-1',
        do: 'If an order is on screen press **New table**, then press **Table 12** on the cover pad.',
        watch:
          'A `v1` badge appears in the header. That is the version the server assigned, not a ' +
          'local counter — creation is a mutation like any other (§5).',
      },
      {
        tab: 'A',
        do: 'Tap **Burger**, then **Cola**.',
        watch:
          'Each tile carries the count it has on the ticket, the total climbs, and the header ' +
          'reaches `v3`. One tap is one mutation with its own `mutationId`.',
      },
      {
        tab: 'A',
        do: 'Tap **Burger** a second time.',
        watch:
          'The Burger line reads 2 and the version is `v4`. `ADD_ITEM` merges into the line it ' +
          'finds, so there is no second Burger row — the tile is the quantity control (§16).',
      },
      {
        tab: 'A',
        do: 'Press **Send to kitchen**.',
        watch:
          'Status `SENT_TO_KITCHEN`, and every tile and stepper greys out at once. Items are ' +
          'frozen from here, and it is the transition table in `decide()` that refuses them.',
      },
      {
        tab: 'B',
        route: '/kitchen',
        do: 'Open a second window on the kitchen display.',
        watch:
          'The ticket is in the **New** column. It reached that screen through Postgres, the ' +
          'outbox, Kafka and the consumer projection — the till never called the kitchen.',
      },
      {
        tab: 'B',
        do: 'Press **Start preparing**.',
        watch:
          'The card moves to **Preparing**, and window A follows without a reload. A kitchen ' +
          'command is a mutation with a `baseVersion`, exactly like a POS tap (§17).',
      },
      {
        tab: 'B',
        do: 'Press **Mark ready**.',
        watch: 'The card reaches **Ready** and window A shows `READY`.',
      },
      {
        tab: 'A',
        do: 'Press **Pay card**.',
        watch:
          'Status `PAID`. Payment is allowed from `OPEN` and from `READY` and never while the ' +
          'kitchen is cooking — the button was disabled all through `PREPARING`.',
      },
    ],
  },

  {
    id: 'offline',
    spec: '§19.2',
    title: 'Offline, then a clean sync',
    claim:
      'A till with no network is a till that still takes orders. Creation is queued like anything ' +
      'else, the queue drains in order, and the server answer replaces the local guess.',
    needs:
      'Two windows: POS-1 in window A, `/debug` in window B. The offline switch is in the POS ' +
      'header as well as in the panel below; both throw the same tab-local gate.',
    steps: [
      {
        tab: 'A',
        route: '/pos/pos-1',
        do: 'If an order is on screen, press **New table** to get back to the cover pad.',
      },
      {
        tab: 'A',
        control: 'offline-pos-1',
        do: 'Press **Simulate Offline** in the POS header.',
        watch:
          '`OFFLINE` and `SIMULATED OFFLINE` badges. Reads are cut off as well as writes, so the ' +
          'till cannot quietly learn what another one did and stop being stale.',
      },
      {
        tab: 'A',
        do: 'Press **Table 5** — a brand new order, with no network.',
        watch:
          'The order is on screen with **1 PENDING** and no version badge: nothing has answered ' +
          'yet. The id was minted here, which is what makes the create safe to retry.',
      },
      {
        tab: 'A',
        do: 'Tap **Burger**, then **Coffee**.',
        watch:
          '**3 PENDING**, and the total is right. What is drawn is the projection — the cached ' +
          'snapshot with the queue folded onto it — not a server read.',
      },
      {
        tab: 'A',
        do: 'Press **+** on the Burger line.',
        watch:
          'Burger reads 2 and the badge reads **4 PENDING**: the four §19.2 asks for — create, ' +
          'add, add, change.',
      },
      {
        tab: 'B',
        route: '/debug',
        do: 'In window B, find `pos-1` under **Active terminals**.',
        watch:
          '`offline` true, with a pending count of 4. The browser reports both, because nothing ' +
          'on the server can observe a queue that never left the device.',
      },
      {
        tab: 'A',
        control: 'offline-pos-1',
        do: 'Back in window A, press **Go back online**.',
        watch:
          '**SYNCING**, then the four go one at a time in the order they were made. The count ' +
          'falls to zero and a `v4` badge appears — the canonical order the server returned.',
      },
      {
        tab: 'B',
        do: 'Look at `/debug` again.',
        watch:
          '`pos-1` is back to `offline: false` with a pending count of 0 within one poll, and ' +
          '`processedMutations` has climbed by four.',
      },
    ],
  },

  {
    id: 'blocked-queue',
    spec: '§19.3',
    title: 'Conflict, and the queue behind it',
    claim:
      'A stale mutation does not simply fail — everything queued behind it is provably stale too, ' +
      'so the client stops rather than sending a cascade of conflicts that reads as a broken ' +
      'client. Nothing resolves itself: a person chooses.',
    needs:
      'Two windows: POS-1 in window A, `/debug` in window B. **Create Version Conflict** is what ' +
      'stands in for the second terminal here — it sends one mutation a version low, which is ' +
      'exactly the position a till holding v5 is in after another till has moved the order to v6.',
    steps: [
      {
        tab: 'A',
        route: '/demo',
        control: 'create-version-conflict',
        do: 'Press **Create Version Conflict** in the panel below.',
        watch:
          'The badge reads **armed**. It waits for a mutation at `v2` or higher: creation is ' +
          'defined at v0 and the boundary refuses anything under v1, so a decrement there would ' +
          'be a validation error wearing a conflict label.',
      },
      {
        tab: 'A',
        route: '/pos/pos-1',
        do:
          ARM_WALK +
          ' Get back to the cover pad with **New table** if an order is on screen, press **Table 3**, ' +
          'then tap **Burger** once and let it reach `v2`.',
        watch:
          'The arm is still **armed** — the create went at v0 and the first item at v1, and it ' +
          'declined both. The next tap is the first one it can act on.',
      },
      {
        tab: 'A',
        do: 'Now tap **Cola**, **Coffee** and **French Fries** as fast as you can click.',
        watch:
          'Three mutations staged instantly at v2, v3 and v4 — the screen never greys out. The ' +
          'first goes out at v1 instead of v2, the server refuses it, and the two behind it turn ' +
          '`BLOCKED` without ever being sent.',
      },
      {
        tab: 'A',
        do: 'Read the red banner, then press **Why?**.',
        watch:
          'It names the mutation, the version it went at, the version the server holds and how ' +
          'many are queued behind it. Underneath: the canonical order on one side, this ' +
          'terminal’s queued intent with every `mutationId` and `baseVersion` on the other.',
      },
      {
        tab: 'B',
        route: '/debug',
        do: 'In window B, read **Conflict history**.',
        watch:
          'One row, unresolved: terminal, `mutationId`, the client base version, the server ' +
          'version and status. `blockedMutations` under **Counters** is the same fact as a number.',
      },
      {
        tab: 'A',
        do: 'Press **Rebase onto v2**.',
        watch:
          'The queue is re-issued one at a time, each with a **new** `mutationId` at the version ' +
          'the one before it produced — never a batch re-stamp, because every success moves the ' +
          'version. **Discard** was the other answer, and both belong to the operator.',
      },
      {
        tab: 'B',
        do: 'Look at **Conflict history** once more, and at `blockedMutations`.',
        watch:
          'The row is still there and now reads `REBASED`, and `blockedMutations` has fallen back. ' +
          'The handler writes `resolution` as `null`, because at that moment nobody knows which ' +
          'answer the operator will choose; the browser reports it afterwards, on the one endpoint ' +
          'that exists for it. So the history is a history — every conflict that ever happened — ' +
          'while `blockedMutations` is a **gauge** of the queues halted right now, matching the ' +
          '`BLOCKED` badge on the till. It is best-effort and it names the exact mutations it ' +
          'closes, so a rebase that conflicts again leaves the new row open — and a resolution ' +
          'made while the terminal is offline is never reported at all.',
      },
    ],
  },

  {
    id: 'duplicate-mutation',
    spec: '§19.4',
    title: 'The same mutation, sent twice',
    claim:
      'A retry after a timeout is indistinguishable from a first attempt, so the server has to be ' +
      'the one that tells them apart. `processed_mutations` answers the second with the first ' +
      'one’s result instead of applying it again.',
    needs:
      'One window. The arm is spent by the next mutation that applies, whatever it happens to be ' +
      '— so the order is opened first, and the arm is pressed second.',
    steps: [
      {
        tab: 'A',
        route: '/pos/pos-1',
        do:
          'Open POS-1. Press **New table** if a cover is already open, then **Table 4**, and tap ' +
          '**Burger** once. Note the version and the total.',
      },
      {
        tab: 'A',
        control: 'duplicate-next-mutation',
        do: 'Come back here and press **Duplicate Next Mutation**.',
        watch:
          'The badge reads **armed**. Note also that the till kept its order while you walked ' +
          'away: the pointer is on disk, so it is still there when you go back.',
      },
      {
        tab: 'A',
        route: '/pos/pos-1',
        do: ARM_WALK + ' Tap **Cola** once — one tap, not two.',
        watch:
          'The Cola line reads 1 and the version advanced by exactly 1. The identical body went ' +
          'out twice under one `mutationId`; only the first of them did anything.',
      },
      {
        tab: 'A',
        route: '/demo',
        do: 'Come back and read **What the controls did** at the foot of the panel.',
        watch:
          '`Duplicate Next Mutation — the server answered ALREADY_APPLIED.` The shadow send is ' +
          'logged and thrown away; it never reaches the sync engine, which would read it as this ' +
          'row settling twice.',
      },
      {
        tab: 'A',
        route: '/debug',
        do: 'Open `/debug` and read **Counters**.',
        watch:
          '`duplicateMutationsPrevented` +1, and `processedMutations` — the idempotency ledger — ' +
          'moved by one, not by two.',
      },
    ],
  },

  {
    id: 'reused-mutation-id',
    spec: '§19.5',
    title: 'The same id, a different payload',
    claim:
      'Idempotency is not "remember the id". A client that reuses an id for different work has a ' +
      'bug, and handing back the old result would hide it — so §9 hashes `(orderId, type, ' +
      'payload)` and refuses instead.',
    needs: 'One window. §19.4’s twin, in the same order: open the order first, arm second.',
    steps: [
      {
        tab: 'A',
        route: '/pos/pos-1',
        do: 'Open POS-1 and make sure an order is on screen — press **Table 11** if there is none.',
      },
      {
        tab: 'A',
        control: 'reuse-mutation-id',
        do: 'Come back here and press **Reuse Mutation Id With New Payload**.',
        watch: 'The badge reads **armed**.',
      },
      {
        tab: 'A',
        route: '/pos/pos-1',
        do: ARM_WALK + ' Tap any tile once.',
        watch:
          'The tap applies normally. Behind it a second request went out under the same ' +
          '`mutationId` with a `CREATE_ORDER` body — a different hash under an id already spent.',
      },
      {
        tab: 'A',
        route: '/demo',
        do: 'Read **What the controls did**.',
        watch:
          '`the server answered MUTATION_ID_REUSED`. Note what did not happen: no order was ' +
          'created for table `simulator-reuse`, and no stale result was handed back.',
      },
      {
        tab: 'A',
        route: '/debug',
        do: 'Read **Counters**.',
        watch:
          '`mutationIdReuseRejected` +1 while `duplicateMutationsPrevented` did not move. The two ' +
          'are counted apart on purpose: one is a healthy retry, the other is a client defect.',
      },
    ],
  },

  {
    id: 'duplicate-event',
    spec: '§19.6',
    title: 'The same Kafka event, delivered twice',
    claim:
      'At-least-once delivery means the consumer will see a duplicate eventually. ' +
      '`processed_events` and the projection are written in one transaction, so the replay is ' +
      'recognised and the projection does not move.',
    needs:
      'One window. The worker has to be running, and something must already have been published — ' +
      'run §19.1 first if **Recent domain events** on `/debug` is empty.',
    steps: [
      {
        tab: 'A',
        route: '/debug',
        do:
          'Note `kafkaEventsConsumed` and `duplicateKafkaEventsPrevented` under **Counters**, and ' +
          'what the top card on `/kitchen` says.',
      },
      {
        tab: 'A',
        control: 'replay-last-event',
        do: 'Press **Replay Last Kafka Event** in the panel below.',
        watch:
          'The log names the event it un-published — type, version, and the first bytes of the ' +
          '`eventId`. `outboxEventsPublished` drops by one while it is in flight.',
      },
      {
        tab: 'A',
        do: 'Wait one `OUTBOX_POLL_MS` and read the counters again.',
        watch:
          '`duplicateKafkaEventsPrevented` +1 and `kafkaEventsConsumed` unchanged — the consumer ' +
          'saw the event and recognised it.',
      },
      {
        tab: 'A',
        route: '/kitchen',
        do: 'Look at the ticket the event belonged to.',
        watch:
          'Nothing moved. A duplicate that had been applied would show here as a doubled line or ' +
          'as a state that went backwards.',
      },
    ],
  },

  {
    id: 'outbox-failure',
    spec: '§19.7',
    title: 'The publisher stops; the order does not',
    claim:
      'The scenario that says why the outbox exists. The order and its event commit in one ' +
      'transaction, so a broker that cannot be reached delays the kitchen and can never lose the ' +
      'order: there is no window in which one was written and the other was not.',
    needs: 'Two windows: POS-1 in window A, `/debug` in window B. The worker running.',
    steps: [
      {
        tab: 'B',
        route: '/debug',
        control: 'outbox-pause',
        do: 'Press **Pause Outbox Publisher** in the panel below.',
        watch:
          'The badge reads **paused**. It is a row in Postgres and not a flag in this tab, so it ' +
          'is fleet-wide and it outlives the worker that obeys it.',
      },
      {
        tab: 'A',
        route: '/pos/pos-1',
        do:
          'On POS-1 press **New table** if a cover is open, then **Table 6**, tap **Pizza**, and ' +
          'press **Send to kitchen**.',
        watch:
          'The till is entirely unaffected: `SENT_TO_KITCHEN`, a new version, nothing pending. As ' +
          'far as the operator is concerned the order is placed, because it is.',
      },
      {
        tab: 'B',
        do: 'Read **Delivery** and **Counters** in window B.',
        watch:
          '`outboxEventsPending` has climbed and the oldest-pending age is growing. The rows are ' +
          'there, in order, with their attempt counts still at zero.',
      },
      {
        tab: 'B',
        route: '/kitchen',
        do: 'Look at the kitchen display.',
        watch:
          'No ticket. This is the honest failure mode: the kitchen is behind, and nobody has lost ' +
          'an order or told a customer something untrue.',
      },
      {
        tab: 'B',
        route: '/debug',
        control: 'outbox-pause',
        do: 'Press **Resume Outbox Publisher**.',
        watch:
          'Within one `OUTBOX_POLL_MS` the backlog drains, `outboxEventsPublished` catches up, ' +
          'and the ticket appears on `/kitchen` — in the order the events were written.',
      },
    ],
  },

  {
    id: 'kitchen-race',
    spec: '§19.8',
    title: 'Two kitchen displays, one ticket',
    claim:
      'Kitchen commands are POS commands. The same `expected_version` guard runs, so two displays ' +
      'pressing the same button produce one success and one conflict — never two transitions.',
    needs:
      'Two windows, **both on `/kitchen`**, side by side, with a ticket in **New**. Run §19.1 as ' +
      'far as **Send to kitchen** first if there is none.',
    steps: [
      {
        tab: 'A',
        route: '/kitchen',
        do: 'Put both windows on the kitchen display, showing the same ticket.',
        watch:
          'Both read the same projection, so both hold the same version. That is the setup a race ' +
          'needs, and it is the normal state of two displays in one kitchen.',
      },
      {
        tab: 'A',
        do: 'In **one** window press **Start preparing**, and let the card reach **Preparing** in both.',
        watch:
          'This is setup, not the race. A card in **New** offers **Start preparing** and nothing ' +
          'else, and §19.8 is about two displays pressing **Ready** — so the ticket has to be in ' +
          '**Preparing** before there is a Ready to race for. Both windows follow the projection, ' +
          'so both come to rest holding the same version again.',
      },
      {
        tab: 'B',
        do: 'Now press **Mark ready** in both windows, as close to simultaneously as you can.',
        watch:
          'One card moves to **Ready**. The other shows **Refused:** with the reason, and the ' +
          'card under it is what the projection now says — not a rolled-back optimistic guess. ' +
          'Both commands carried the same `baseVersion`; the second met an order the first had ' +
          'already moved.',
      },
      {
        tab: 'A',
        route: '/debug',
        do: 'Read **Conflict history**.',
        watch:
          'A row whose terminal is `kitchen-display`. Nothing in the conflict machinery knows or ' +
          'cares that this one came from a kitchen (ADR 012).',
      },
    ],
  },

  {
    id: 'printer-down',
    spec: '§19.9',
    title: 'The printer is down',
    claim:
      'The printer is the second at-least-once pipeline and the one with a physical device on the ' +
      'end. It retries, it dead-letters where a person can see it, and none of that ever touches ' +
      'the order.',
    needs:
      'Two windows: POS-1 in window A, `/debug` in window B, and the worker running. ' +
      '`PRINT_MAX_ATTEMPTS` is 5 by default, so the walk to dead-letter takes a few seconds of ' +
      'backoff.',
    steps: [
      {
        tab: 'B',
        route: '/debug',
        control: 'printer-fail',
        do: 'Press **Fail Printer** in the panel below.',
        watch:
          'The badge reads **failing**. Like the outbox switches this is a row in Postgres, but ' +
          'it takes effect immediately: the fake device reads the row on every print rather than ' +
          'polling it.',
      },
      {
        tab: 'A',
        route: '/pos/pos-1',
        do:
          'On POS-1 open a fresh table — **New table** first if one is already open — tap ' +
          'something, and press **Send to kitchen**.',
        watch: 'The order goes through normally. The till has no opinion about the printer.',
      },
      {
        tab: 'B',
        do: 'Watch **Print jobs** under **Delivery**.',
        watch:
          'The row climbs through its attempts with the last error attached, then lands on ' +
          '`DEAD_LETTER` after the fifth. Copy the order id out of that row.',
      },
      {
        tab: 'B',
        control: 'printer-fail',
        do: 'Press **Fix Printer**.',
        watch:
          'The badge reads **healthy** again — and nothing retries on its own. A dead-lettered ' +
          'job is a decision waiting for a person, which is the point of dead-lettering it.',
      },
      {
        tab: 'B',
        do: 'Retry the job from a terminal, with the order id from that row.',
        command: 'pnpm -F @pos/worker printer retry <orderId>',
        watch:
          'The row goes back to pending and then to `PRINTED`. The kitchen ticket printed once, ' +
          'late — and the order it describes was never in doubt.',
      },
    ],
  },

  {
    id: 'multi-instance',
    spec: '§19.10',
    title: 'Two API instances, one broadcast',
    claim:
      'A socket is held by one process. With two API instances behind a load balancer, a mutation ' +
      'applied on instance A has to reach a client connected to instance B — which is what the ' +
      'Redis adapter is for.',
    needs:
      'A terminal, not this page. **This scenario is a test, not a click-through**, and saying so ' +
      'is more honest than staging a two-instance walk inside one browser.',
    steps: [
      {
        do: 'Run the multi-instance suite from the repository root.',
        command: 'pnpm verify:multi',
        watch:
          'It brings up the two-replica stack from `docker-compose.multi.yml`, migrates it, waits ' +
          'for both instances to be ready, runs `multi-instance.integration.test.ts`, tears down, ' +
          'and writes the output to a file.',
      },
      {
        do: 'Read the tail of that file.',
        watch:
          'The assertion is the scenario: subscribe a client on instance B, mutate against ' +
          'instance A, and the broadcast arrives. The suite is excluded from ' +
          '`pnpm -F @pos/api test` on purpose — it needs its own Compose file and its own config, ' +
          'and a default test run must not depend on either.',
      },
    ],
  },
];

export const scenarioById = (id: string): DemoScenario | undefined =>
  DEMO_SCENARIOS.find((scenario) => scenario.id === id);

/** The controls a scenario touches, de-duplicated, in the order its steps reach them. */
export function controlsUsed(scenario: DemoScenario): DemoControl[] {
  const seen: DemoControl[] = [];
  for (const step of scenario.steps) {
    if (step.control !== undefined && !seen.includes(step.control)) {
      seen.push(step.control);
    }
  }
  return seen;
}

/** The windows a scenario needs, in the order it first names them. Empty when it needs none. */
export function tabsUsed(scenario: DemoScenario): string[] {
  const seen: string[] = [];
  for (const step of scenario.steps) {
    if (step.tab !== undefined && !seen.includes(step.tab)) {
      seen.push(step.tab);
    }
  }
  return seen;
}

/**
 * The two bits of markup the prose above uses: `**bold**` for something to press, and backticks
 * for an identifier. Rendering them means `v-html`, so the input is **escaped first** and only the
 * two constructs are re-introduced. The strings are constants in this file rather than anything a
 * user supplies, but a renderer that escapes only when it remembers to is a renderer that will one
 * day be handed a conflict message from the server.
 */
export function renderInline(text: string): string {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * How far through a scenario the operator is. The ticks are a demo aid and live in memory only:
 * persisting them would mean a second walk-through starting half done.
 */
export function progressLabel(done: ReadonlySet<number>, total: number): string {
  const ticked = [...done].filter((index) => index >= 0 && index < total).length;
  return `${ticked} of ${total}`;
}
