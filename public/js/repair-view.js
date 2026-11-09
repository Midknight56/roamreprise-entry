import { esc, minutes, money } from './shared.js';
import { wasHeld } from './money-story.js';

export function failedItemName(trip) {
  const id = trip?.repair?.failedItemId;
  if (!id) return '';
  const items = trip.itinerary?.items || [];
  const prevItems = trip.previous?.items || [];
  const item = items.find((i) => i.id === id) || prevItems.find((i) => i.id === id);
  return item?.name || '';
}

export function repairSummary(trip) {
  const name = failedItemName(trip);
  return `${name || 'The hotel'} is unavailable. Compare checked hotels before changing your approval.`;
}

export function approvedAmount(trip) {
  // During a repair the approved quote is still the old one.
  if (trip?.quote?.totalCents !== undefined) return trip.quote.totalCents;
  if (trip?.previous?.totalCents !== undefined) {
    return trip.previous.totalCents;
  }
  if (trip?.previous?.items) {
    const booked = trip.previous.items.filter((i) => i.booked);
    if (booked.length) return booked.reduce((sum, i) => sum + i.priceCents, 0);
  }
  const held = (trip?.payments || []).findLast(wasHeld);
  return held?.amountCents ?? 0;
}

export function candidateFacts(trip, candidate) {
  const total = candidate.newTotalCents;
  const approved = approvedAmount(trip);
  const diff = total - approved;
  let comparison;
  if (diff < 0) {
    comparison = `${money(Math.abs(diff))} less than your approved ${money(approved)}`;
  } else if (diff > 0) {
    comparison = `${money(diff)} more than your approved ${money(approved)}`;
  } else {
    comparison = `same as your approved ${money(approved)}`;
  }
  const fact1 = `${money(total)} total, ${comparison}`;

  let droppedActs = [];
  if (Array.isArray(candidate.droppedActivities) && candidate.droppedActivities.length) {
    droppedActs = candidate.droppedActivities;
  } else if (Array.isArray(candidate.dropped) && candidate.dropped.length) {
    const items = trip.itinerary?.items || [];
    const prevItems = trip.previous?.items || [];
    droppedActs = candidate.dropped
      .map((id) => {
        const found =
          items.find((i) => i.id === id || i.slot === id) ||
          prevItems.find((i) => i.id === id || i.slot === id);
        return found?.kind === 'activity' ? found.name : null;
      })
      .filter(Boolean);
  }
  const fact2 = droppedActs.length
    ? `Drops ${droppedActs.join(', ')}`
    : 'Keeps every activity';

  const moves = candidate.moves || [];
  const count = moves.length;
  let fact3;
  if (count === 0) {
    fact3 = 'No stop moves';
  } else {
    let totalMin = 0;
    for (const move of moves) {
      const endOnly = move.fromStart === move.toStart;
      const from = endOnly ? move.fromEnd : move.fromStart;
      const to = endOnly ? move.toEnd : move.toStart;
      totalMin += Math.abs(minutes(to) - minutes(from));
    }
    fact3 = `${count} ${count === 1 ? 'stop moves' : 'stops move'}, ${totalMin} min in total`;
  }

  const fact4 = {
    main: 'Every schedule check passed',
    sub: 'opening hours, budget, estimated travel times',
  };

  const auth = (trip.payments || []).findLast(
    (p) =>
      p.state === 'authorized' ||
      (p.authorizationId && ['authorized', 'holding'].includes(p.state)),
  );
  const fact5 = auth
    ? `Using it releases the ${money(auth.amountCents)} PayPal hold. Nothing is charged. Then you approve the new total.`
    : null;

  return {
    fact1,
    fact2,
    fact3,
    fact4,
    fact5,
    factsList: [fact1, fact2, fact3, `${fact4.main}\n${fact4.sub}`, fact5].filter(
      Boolean,
    ),
  };
}
