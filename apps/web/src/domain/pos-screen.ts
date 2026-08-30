import type {
  ConflictReason,
  MenuItem,
  MutationType,
  OrderSnapshot,
  OrderStatus,
  TerminalProfile,
} from '@pos/contracts';
import { BAR_MENU } from '@pos/contracts';

import type { PendingMutationRecord } from '../persistence/db';

/**
 * What the POS screen renders, as pure functions of the projection.
 *
 * It lives beside `project-queue.ts` and `debug-view.ts` for the same reason: the view holds no
 * rules, and rules that are only exercised through a component are rules that are not tested.
 * Everything here reads the **projection** — the cache with the queue folded onto it — so none of
 * it can accidentally depend on a server event arriving. That matters more than it looks: M13 made
 * `PUSH` and `POLLING` differ in latency and nothing else, and a screen that waited on a socket
 * would break the polling half silently (§15).
 */

/** One menu tile. `count` is what the operator has already put on the ticket, live. */
export interface MenuTile {
  id: string;
  name: string;
  priceCents: number;
  count: number;
}

/**
 * The menu this till sells.
 *
 * The bar filter is a client-side projection of the one menu the API returns; `BAR_MENU` is the
 * list and @pos/contracts explains why it is not a column. A bar terminal whose filter matched
 * nothing would be an empty screen, which reads as a broken till rather than as a misconfigured
 * one — so an empty match falls back to the full menu.
 */
export function menuFor(items: readonly MenuItem[], profile: TerminalProfile): MenuItem[] {
  if (profile !== 'bar') {
    return [...items];
  }

  const drinks = items.filter((item) => BAR_MENU.has(item.id));
  return drinks.length > 0 ? drinks : [...items];
}

/**
 * The tiles, each carrying the quantity already ordered.
 *
 * §16 asks for quantity in one tap, and `ADD_ITEM` already merges into the existing line — in
 * `decide()` and in `project-queue.ts` alike — so a second tap on a tile *is* the quantity
 * control. What was missing was the tile saying so.
 */
export function menuTiles(
  items: readonly MenuItem[],
  profile: TerminalProfile,
  order: OrderSnapshot | undefined,
): MenuTile[] {
  const counts = new Map((order?.items ?? []).map((line) => [line.productId, line.quantity]));

  return menuFor(items, profile).map((item) => ({
    id: item.id,
    name: item.name,
    priceCents: item.priceCents,
    count: counts.get(item.id) ?? 0,
  }));
}

/** What the operator may do right now. `halted` is §14.1: nothing on this order until it resolves. */
export interface Affordances {
  order: boolean;
  pay: boolean;
  cancel: boolean;
  send: boolean;
}

export function affordances(order: OrderSnapshot | undefined, halted: boolean): Affordances {
  if (order === undefined || halted) {
    return { order: false, pay: false, cancel: false, send: false };
  }

  const status: OrderStatus = order.status;

  return {
    // Items are frozen once the kitchen has the order (§8).
    order: status === 'OPEN',
    // `ALLOWED_TRANSITIONS` permits PAID from OPEN and from READY, and from nowhere else.
    pay: status === 'OPEN' || status === 'READY',
    cancel: status !== 'PAID' && status !== 'CANCELLED',
    send: status === 'OPEN' && order.items.length > 0,
  };
}

/**
 * The conflict banner's headline — the one line that goes above the two buttons.
 *
 * The evidence stays on screen underneath; this is what has to be readable across a service pass,
 * so it names the mutation, the two versions and how much is stuck behind it, and nothing else.
 */
export interface ConflictHeadline {
  reason: ConflictReason;
  /** Undefined only if the queue was drained between the halt and this render. */
  mutationType: MutationType | undefined;
  clientBaseVersion: number;
  serverVersion: number;
  /** Mutations queued behind the conflicted one. They are `BLOCKED` and were never sent (§14.1). */
  blockedCount: number;
}

export function conflictHeadline(
  conflict:
    { reason: ConflictReason; clientBaseVersion: number; serverVersion: number } | undefined,
  queue: readonly PendingMutationRecord[],
): ConflictHeadline | undefined {
  if (conflict === undefined) {
    return undefined;
  }

  const conflicted = queue.find((row) => row.status === 'CONFLICT');

  return {
    reason: conflict.reason,
    mutationType: conflicted?.type,
    clientBaseVersion: conflict.clientBaseVersion,
    serverVersion: conflict.serverVersion,
    blockedCount: queue.filter((row) => row.status === 'BLOCKED').length,
  };
}

/**
 * The one-tap covers. Typing into a text input is the slowest thing on the screen and it is on the
 * critical path, so the common ones are a tap; the input stays for everything else.
 *
 * Bare values, never `Tab 2`: `coverNoun` is what names them, on the button and in the heading
 * alike, and a value that carried its own noun would be read out twice.
 */
export function coversFor(profile: TerminalProfile): string[] {
  return profile === 'bar'
    ? ['1', '2', '3', '4', '5', '6']
    : ['1', '2', '3', '4', '5', '6', '11', '12'];
}

/** What a cover is called here. The bar runs tabs, the floor runs tables. */
export function coverNoun(profile: TerminalProfile): string {
  return profile === 'bar' ? 'Tab' : 'Table';
}
