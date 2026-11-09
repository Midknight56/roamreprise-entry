export function droppedItemLabel(itinerary, slotId) {
  const item = itinerary.items.find((current) => current.slot === slotId);
  if (item?.name) return item.name;
  const labels = { 'd1-late': 'Day 1 evening', 'd2-pm': 'Day 2 afternoon' };
  return labels[slotId] || slotId.replace(/^d(\d+)-(.+)$/, (_, day, part) => `Day ${day} ${part.replaceAll('-', ' ')}`) || 'this slot';
}
