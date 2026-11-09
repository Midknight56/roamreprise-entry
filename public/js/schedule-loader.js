import { BasicSchedule } from './schedule-basic.js';
// A missing or unusable vendor module must leave the itinerary interactive.
export async function createSchedule(container, options = {}) {
  if (options.wanted !== 'basic') {
    try {
      const bryntum =
        await import('/vendor/bryntum/scheduler/scheduler.module.js');
      const { BryntumSchedule } = await import('./schedule-bryntum.js');
      const view = new BryntumSchedule(container, bryntum);
      container.dataset.view = 'bryntum';
      return view;
    } catch {
      container.replaceChildren();
    }
  }
  container.dataset.view = 'basic';
  return new BasicSchedule(container);
}
